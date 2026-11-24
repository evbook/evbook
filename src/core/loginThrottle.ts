import type { SqlDatabase } from "../platform/ports";

/**
 * Failed sign-ins slow down whoever keeps getting the app password wrong. The
 * password is the one thing standing between the internet and a deployment, so
 * without this a guesser is limited only by how fast the server answers.
 *
 * Two cases, because only one of them can safely lock anybody out:
 *
 * - The runtime knows the client's address (`AppEnv.clientAddress`: Cloudflare
 *   always, Node behind a proxy it is told to trust). Five attempts that do not
 *   end in a sign-in lock that address for a minute, every further one doubles
 *   the lock, up to an hour. A locked address is answered 429 without its
 *   password being looked at.
 * - It does not, or the address is one many people share (see `clientKey`).
 *   Every such request may be the owner, so nothing is locked: failures are
 *   counted together under `*`, and from the fifth on each sign-in waits before
 *   its password is checked, a second doubling up to eight. Waits run side by
 *   side, so a guesser sending many requests at once is slowed rather than
 *   stopped. That is the price of never locking the owner out, and the reason
 *   to set TRUST_PROXY behind a reverse proxy.
 *
 * An address's attempt is counted before its password is checked, in the same
 * statement that checks and sets the lock. Counting only the failures, after
 * the check, let every request that arrived before the first failure was
 * written through: a burst of a few hundred got a few hundred guesses.
 *
 * Failures are forgotten once 15 minutes pass with neither a new one nor a
 * lock, and a successful sign-in forgets them at once. An address that has
 * been locked is remembered for a day after its lock ends instead: forgetting
 * it a quarter hour later gave a patient guesser five tries, a one-minute
 * lock and a quiet quarter hour, over and over — some twenty an hour — and the
 * doubling never came into play. Remembered, every further try doubles the
 * lock, a couple of dozen a day. The cron sweeps old rows
 * (`forgetLoginFailures`). The table lives in the app's database, so it
 * works the same on D1 and on SQLite and survives a restart.
 */

/** Attempts before the first lock or wait. */
export const FREE_FAILURES = 5;
/** Quiet time after which a client's failures are forgotten. */
export const FORGET_AFTER_MS = 15 * 60 * 1000;
/** How long after its lock ends an address that was locked is remembered. */
export const REMEMBER_LOCKED_MS = 24 * 60 * 60 * 1000;
/**
 * SQL for "this row is forgotten", given the placeholders holding now,
 * FORGET_AFTER_MS and REMEMBER_LOCKED_MS. `locked_until` stays set once a row
 * has been locked, until the row is forgotten or a sign-in deletes it.
 */
function forgotten(now: string, forget: string, remember: string): string {
  return `${now} - MAX(last_at, COALESCE(locked_until, 0)) > CASE WHEN locked_until IS NULL THEN ${forget} ELSE ${remember} END`;
}
const FIRST_LOCK_MS = 60 * 1000;
const MAX_LOCK_MS = 60 * 60 * 1000;
/** Doublings after which the first lock exceeds the cap (2^6 minutes > 60). */
const DOUBLINGS_TO_CAP = 6;
const FIRST_WAIT_MS = 1000;
/**
 * Eight seconds holds a guesser who waits for each answer to a few hundred
 * tries an hour, while the owner, who has to wait it out once, still gets in
 * well inside any proxy's or browser's request timeout.
 */
const MAX_WAIT_MS = 8 * 1000;

/** The row everyone the runtime cannot tell apart shares. */
export const UNKNOWN_CLIENT = "*";

export type LoginAttempt =
  /**
   * Check the password, after waiting `waitMs`. `lockedUntil` is set when this
   * attempt already started a lock: a wrong password is then answered 429.
   */
  | { kind: "check"; waitMs: number; lockedUntil: number | null }
  /** Known client, locked: refuse without checking the password. */
  | { kind: "locked"; retryAfterMs: number };

/** How long an address is locked after its `attempts`-th attempt. */
export function lockMs(attempts: number): number {
  if (attempts < FREE_FAILURES) return 0;
  return Math.min(FIRST_LOCK_MS * 2 ** (attempts - FREE_FAILURES), MAX_LOCK_MS);
}

/**
 * The whole seconds a refused client is told to wait, at least one. The lock
 * an attempt starts may have run out by the time its password is checked (a
 * slow request body); `Retry-After: 0` or a negative value would then invite
 * an immediate retry and read "Try again in 0 seconds" on the sign-in screen.
 */
export function retryAfterSeconds(ms: number): number {
  return Math.max(1, Math.ceil(ms / 1000));
}

/** How long an unknown client waits once `failures` have been counted. */
export function waitMs(failures: number): number {
  if (failures < FREE_FAILURES) return 0;
  return Math.min(FIRST_WAIT_MS * 2 ** (failures - FREE_FAILURES), MAX_WAIT_MS);
}

/**
 * The key a client's attempts are counted under: an IPv4 address as it is, an
 * IPv6 address by its /64, since one connection usually gets a whole /64 and
 * could otherwise step to a fresh address for every guess.
 *
 * null — counted as unknown, slowed but never locked — for anything that is
 * not an address, and for an address that is not one person's: loopback, a
 * private or link-local network, or a carrier's shared range. Those are what a
 * tunnel, a second proxy or a LAN put in front of everybody, and locking one
 * would lock the owner out with the guesser.
 */
export function clientKey(address: string | null | undefined): string | null {
  const parsed = parseAddress(address);
  if (!parsed || !isPublic(parsed)) return null;
  if (parsed.v4) return parsed.v4.join(".");
  return `${parsed.v6
    .slice(0, 4)
    .map((h) => h.toString(16))
    .join(":")}::/64`;
}

/**
 * Whether `address` is loopback, private, link-local or carrier-shared: an
 * address a proxy in front of this server could connect from. Node trusts
 * X-Forwarded-For only from such a peer (src/platform/node/proxy.ts).
 */
export function isLocalAddress(address: string | null | undefined): boolean {
  const parsed = parseAddress(address);
  return parsed !== null && !isPublic(parsed);
}

type Parsed = { v4: number[]; v6?: undefined } | { v4?: undefined; v6: number[] };

function parseAddress(address: string | null | undefined): Parsed | null {
  if (!address) return null;
  const trimmed = address.trim().replace(/^\[(.*)\]$/, "$1");
  const v4 = ipv4(trimmed);
  if (v4) return { v4 };
  if (!trimmed.includes(":")) return null;
  const hextets = ipv6(trimmed.split("%")[0]!);
  if (!hextets) return null;
  // An IPv4 address the socket reports in IPv6 form (::ffff:1.2.3.4) is that IPv4 address.
  if (hextets.slice(0, 5).every((h) => h === 0) && hextets[5] === 0xffff) {
    return { v4: [hextets[6]! >> 8, hextets[6]! & 0xff, hextets[7]! >> 8, hextets[7]! & 0xff] };
  }
  return { v6: hextets };
}

function isPublic(parsed: Parsed): boolean {
  if (parsed.v4) {
    const [a, b] = parsed.v4 as [number, number];
    if (a === 0 || a === 10 || a === 127) return false; // this network, private, loopback
    if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
    if (a === 169 && b === 254) return false; // link-local
    if (a === 172 && b >= 16 && b <= 31) return false; // private
    if (a === 192 && b === 168) return false; // private
    return true;
  }
  const v6 = parsed.v6;
  if (v6.slice(0, 7).every((h) => h === 0) && v6[7]! <= 1) return false; // :: and ::1
  if ((v6[0]! & 0xfe00) === 0xfc00) return false; // unique local
  if ((v6[0]! & 0xffc0) === 0xfe80) return false; // link-local
  return true;
}

function ipv4(text: string): number[] | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN));
  return octets.every((octet) => octet <= 255) ? octets : null;
}

function ipv6(text: string): number[] | null {
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const groups = (half: string | undefined, last: boolean): number[] | null => {
    if (!half) return [];
    const out: number[] = [];
    const parts = half.split(":");
    for (const [i, part] of parts.entries()) {
      // A dotted IPv4 tail is only allowed as the address's final 32 bits.
      if (last && i === parts.length - 1 && part.includes(".")) {
        const v4 = ipv4(part);
        if (!v4) return null;
        const [a, b, c, d] = v4 as [number, number, number, number];
        out.push((a << 8) | b, (c << 8) | d);
      } else if (/^[0-9a-f]{1,4}$/i.test(part)) {
        out.push(parseInt(part, 16));
      } else {
        return null;
      }
    }
    return out;
  };
  const head = groups(halves[0], halves.length === 1);
  const tail = groups(halves[1], true);
  if (!head || !tail) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const missing = 8 - head.length - tail.length;
  return missing >= 1 ? [...head, ...new Array<number>(missing).fill(0), ...tail] : null;
}

/**
 * A sign-in from `client` (a `clientKey`, or null when unknown) is starting:
 * whether to check its password, and after how long.
 */
export async function beginLogin(db: SqlDatabase, client: string | null, now: number): Promise<LoginAttempt> {
  if (client === null) {
    const row = await db
      .prepare("SELECT failures, last_at FROM login_failures WHERE client = ?")
      .bind(UNKNOWN_CLIENT)
      .first<{ failures: number; last_at: number }>();
    const fresh = row !== null && now - row.last_at <= FORGET_AFTER_MS;
    return { kind: "check", waitMs: fresh ? waitMs(row.failures) : 0, lockedUntil: null };
  }
  // One statement: count this attempt, and from the fifth on lock the address
  // straight away — unless it is locked already, in which case nothing is
  // updated and nothing returned. A forgotten row starts over at one. Every
  // value on the right is the row as it was, so `n` is spelled out twice.
  const n = `CASE WHEN ${forgotten("?2", "?3", "?8")} THEN 1 ELSE failures + 1 END`;
  const counted = await db
    .prepare(
      "INSERT INTO login_failures (client, failures, last_at) VALUES (?1, 1, ?2) " +
        `ON CONFLICT (client) DO UPDATE SET failures = ${n}, last_at = ?2, locked_until = CASE ` +
        `WHEN ${n} < ?4 THEN NULL ` +
        `WHEN ${n} - ?4 >= ?7 THEN ?2 + ?6 ` +
        `ELSE ?2 + (?5 << (${n} - ?4)) END ` +
        "WHERE locked_until IS NULL OR locked_until <= ?2 " +
        "RETURNING locked_until",
    )
    .bind(client, now, FORGET_AFTER_MS, FREE_FAILURES, FIRST_LOCK_MS, MAX_LOCK_MS, DOUBLINGS_TO_CAP, REMEMBER_LOCKED_MS)
    .first<{ locked_until: number | null }>();
  if (counted) return { kind: "check", waitMs: 0, lockedUntil: counted.locked_until };
  const held = await db
    .prepare("SELECT locked_until FROM login_failures WHERE client = ?")
    .bind(client)
    .first<{ locked_until: number | null }>();
  return { kind: "locked", retryAfterMs: Math.max((held?.locked_until ?? now) - now, 1000) };
}

/**
 * The password was wrong. An address's attempt is already counted; for the
 * unknown clients the failure is counted now, and only ever slows them down.
 */
export async function loginFailed(db: SqlDatabase, client: string | null, now: number): Promise<void> {
  if (client !== null) return;
  await db
    .prepare(
      "INSERT INTO login_failures (client, failures, last_at) VALUES (?1, 1, ?2) " +
        "ON CONFLICT (client) DO UPDATE SET failures = CASE WHEN ?2 - last_at > ?3 THEN 1 ELSE failures + 1 END, last_at = ?2",
    )
    .bind(UNKNOWN_CLIENT, now, FORGET_AFTER_MS)
    .run();
}

/** A successful sign-in: whatever was counted against this client is forgotten, a lock it started included. */
export async function loginSucceeded(db: SqlDatabase, client: string | null): Promise<void> {
  await db
    .prepare("DELETE FROM login_failures WHERE client = ?")
    .bind(client ?? UNKNOWN_CLIENT)
    .run();
}

/**
 * Drops the rows nobody needs any more. Run from the cron rather than on every
 * failure: the condition cannot use an index, and a scan per wrong password
 * would let anyone with many addresses spend D1's free row reads.
 */
export async function forgetLoginFailures(db: SqlDatabase, now: number): Promise<void> {
  await db
    .prepare(`DELETE FROM login_failures WHERE ${forgotten("?1", "?2", "?3")}`)
    .bind(now, FORGET_AFTER_MS, REMEMBER_LOCKED_MS)
    .run();
}
