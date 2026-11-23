import type { SqlDatabase } from "../platform/ports";

/**
 * Failed sign-ins slow down whoever keeps getting the app password wrong. The
 * password is the one thing standing between the internet and a deployment, so
 * without this a guesser is limited only by how fast the server answers.
 *
 * Two cases, because only one of them can safely lock anybody out:
 *
 * - The runtime knows the client's address (`AppEnv.clientAddress`: Cloudflare
 *   always, Node behind a proxy it is told to trust). Five failures from that
 *   address lock it for a minute, every further one doubles the lock, up to an
 *   hour. A locked address is answered 429 without its password being looked
 *   at, so the lock cannot be used to test guesses either.
 * - It does not. Every such request may be the owner, so nothing is locked:
 *   failures are counted together under `*`, and from the fifth on each sign-in
 *   waits before its password is checked, a second doubling up to eight. Waits
 *   run side by side, so a guesser sending many requests at once is slowed
 *   rather than stopped. That is the price of never locking the owner out, and
 *   the reason to set TRUST_PROXY behind a reverse proxy.
 *
 * Failures are forgotten once 15 minutes pass with neither a new one nor a
 * lock, and a successful sign-in forgets them at once. The table lives in the
 * app's database, so it works the same on D1 and on SQLite and survives a
 * restart.
 */

/** Failures before the first lock or wait. */
export const FREE_FAILURES = 5;
/** Quiet time after which a client's failures are forgotten. */
export const FORGET_AFTER_MS = 15 * 60 * 1000;
const FIRST_LOCK_MS = 60 * 1000;
const MAX_LOCK_MS = 60 * 60 * 1000;
const FIRST_WAIT_MS = 1000;
/**
 * Eight seconds holds a guesser who waits for each answer to a few hundred
 * tries an hour, while the owner, who has to wait it out once, still gets in
 * well inside any proxy's or browser's request timeout.
 */
const MAX_WAIT_MS = 8 * 1000;

/** The row everyone the runtime cannot tell apart shares. */
export const UNKNOWN_CLIENT = "*";

export type LoginGate =
  | { kind: "open" }
  /** Unknown client: wait this long, then check the password. */
  | { kind: "wait"; ms: number }
  /** Known client: refuse without checking the password. */
  | { kind: "locked"; retryAfterMs: number };

/** How long an address is locked after its `failures`-th failure. */
export function lockMs(failures: number): number {
  if (failures < FREE_FAILURES) return 0;
  return Math.min(FIRST_LOCK_MS * 2 ** (failures - FREE_FAILURES), MAX_LOCK_MS);
}

/** How long an unknown client waits once `failures` have been counted. */
export function waitMs(failures: number): number {
  if (failures < FREE_FAILURES) return 0;
  return Math.min(FIRST_WAIT_MS * 2 ** (failures - FREE_FAILURES), MAX_WAIT_MS);
}

/**
 * The key a client's failures are counted under: an IPv4 address as it is, an
 * IPv6 address by its /64, since one connection usually gets a whole /64 and
 * could otherwise step to a fresh address for every guess. null for anything
 * that is not an address, which then counts as unknown.
 */
export function clientKey(address: string | null | undefined): string | null {
  if (!address) return null;
  const trimmed = address.trim().replace(/^\[(.*)\]$/, "$1");
  const v4 = ipv4(trimmed);
  if (v4) return v4;
  if (!trimmed.includes(":")) return null;
  const hextets = ipv6(trimmed.split("%")[0]!);
  if (!hextets) return null;
  // An IPv4 address the socket reports in IPv6 form (::ffff:1.2.3.4) is that IPv4 address.
  if (hextets.slice(0, 5).every((h) => h === 0) && hextets[5] === 0xffff) {
    return [hextets[6]! >> 8, hextets[6]! & 0xff, hextets[7]! >> 8, hextets[7]! & 0xff].join(".");
  }
  return `${hextets
    .slice(0, 4)
    .map((h) => h.toString(16))
    .join(":")}::/64`;
}

function ipv4(text: string): string | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN));
  return octets.every((octet) => octet <= 255) ? octets.join(".") : null;
}

function ipv6(text: string): number[] | null {
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const groups = (half: string | undefined): number[] | null => {
    if (!half) return [];
    const out: number[] = [];
    const parts = half.split(":");
    for (const [i, part] of parts.entries()) {
      if (i === parts.length - 1 && part.includes(".")) {
        const v4 = ipv4(part);
        if (!v4) return null;
        const [a, b, c, d] = v4.split(".").map(Number) as [number, number, number, number];
        out.push((a << 8) | b, (c << 8) | d);
      } else if (/^[0-9a-f]{1,4}$/i.test(part)) {
        out.push(parseInt(part, 16));
      } else {
        return null;
      }
    }
    return out;
  };
  const head = groups(halves[0]);
  const tail = groups(halves[1]);
  if (!head || !tail) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const missing = 8 - head.length - tail.length;
  return missing >= 1 ? [...head, ...new Array<number>(missing).fill(0), ...tail] : null;
}

interface FailureRow {
  failures: number;
  last_at: number;
  locked_until: number | null;
}

/** What to do with a sign-in from `client` (a `clientKey`, or null when unknown) before its password is checked. */
export async function loginGate(db: SqlDatabase, client: string | null, now: number): Promise<LoginGate> {
  const row = await db
    .prepare("SELECT failures, last_at, locked_until FROM login_failures WHERE client = ?")
    .bind(client ?? UNKNOWN_CLIENT)
    .first<FailureRow>();
  if (!row || now - Math.max(row.last_at, row.locked_until ?? 0) > FORGET_AFTER_MS) return { kind: "open" };
  if (client === null) {
    const ms = waitMs(row.failures);
    return ms > 0 ? { kind: "wait", ms } : { kind: "open" };
  }
  if (row.locked_until !== null && row.locked_until > now) {
    return { kind: "locked", retryAfterMs: row.locked_until - now };
  }
  return { kind: "open" };
}

/**
 * Counts a wrong password. Returns the lock it starts, so the answer to the
 * failure that crosses the line can already say so; for an unknown client it
 * is always open, since nothing is ever locked for one.
 */
export async function recordLoginFailure(db: SqlDatabase, client: string | null, now: number): Promise<LoginGate> {
  // Forgetting stale rows here keeps the table as small as the last quarter
  // hour of failures, without a sweep of its own.
  await db
    .prepare("DELETE FROM login_failures WHERE MAX(last_at, COALESCE(locked_until, 0)) < ?")
    .bind(now - FORGET_AFTER_MS)
    .run();
  // One statement, so concurrent failures each count on D1 and SQLite alike.
  const counted = await db
    .prepare(
      "INSERT INTO login_failures (client, failures, last_at) VALUES (?1, 1, ?2) " +
        "ON CONFLICT (client) DO UPDATE SET failures = failures + 1, last_at = ?2 RETURNING failures",
    )
    .bind(client ?? UNKNOWN_CLIENT, now)
    .first<{ failures: number }>();
  const lock = client === null ? 0 : lockMs(counted?.failures ?? 0);
  if (lock === 0) return { kind: "open" };
  await db
    .prepare("UPDATE login_failures SET locked_until = MAX(COALESCE(locked_until, 0), ?) WHERE client = ?")
    .bind(now + lock, client)
    .run();
  return { kind: "locked", retryAfterMs: lock };
}

/** A successful sign-in: whatever was counted against this client is forgotten. */
export async function clearLoginFailures(db: SqlDatabase, client: string | null): Promise<void> {
  await db
    .prepare("DELETE FROM login_failures WHERE client = ?")
    .bind(client ?? UNKNOWN_CLIENT)
    .run();
}
