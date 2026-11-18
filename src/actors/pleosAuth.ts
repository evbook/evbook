import { decryptString, encryptString } from "../core/crypto";
import { PleosClient } from "../core/pleos/api";
import type { AppEnv } from "../platform/env";
import type { ActorStorage, PleosTokenAnswer } from "../platform/ports";
import { isPleosBrand } from "@shared/api-types";

/**
 * The access token of one Pleos key: the one place it is issued and kept.
 *
 * Pleos gives a personal key one live token at a time: issuing a new token
 * cancels the previous one, which is then refused with HTTP 403. A key covers
 * every car its owner had when it was issued, and each car is its own actor,
 * so if each minted its own token they would cancel each other on every pass
 * (evcc hit exactly this). Hence one instance per key, under the auth actor's
 * runtime (named after the account, `pleos-…`, so no new Durable Object
 * class), which every car on the key asks. Calls are serialized by the
 * runtime, and a token request already under way is shared, so two cars asking
 * at once get one token.
 *
 * Another program reading with the same key (Home Assistant, evcc, Node-RED)
 * cancels EVBook's token the same way, and EVBook cancels its. That cannot be
 * fixed from here; it can be recognised. A car that finds a token refused
 * before its expiry hands it back as `stale`; three such refusals within an
 * hour mean the key is shared, and the key rests for a quarter of an hour
 * rather than joining a token war.
 */

/** Every Pleos account's name starts so: the auth actor instance holding its token is named after it. */
export const PLEOS_ACCOUNT_PREFIX = "pleos-";

const STATE = "pleos:token";
const MIN = 60_000;
/** Get a new token this long before the old one expires. */
const RENEW_MARGIN_MS = 5 * MIN;
/** Refusals of a live token within this window that mean another program holds the key. */
const SHARED_WINDOW_MS = 60 * MIN;
const SHARED_REFUSALS = 3;
const SHARED_PAUSE_MS = 15 * MIN;

interface Stored {
  tokenEnc: string | null;
  expiresAt: number;
  /** When a live token was handed back as refused, within the last hour. */
  refusals: number[];
  pausedUntil: number | null;
}

const EMPTY: Stored = { tokenEnc: null, expiresAt: 0, refusals: [], pausedUntil: null };

interface KeyRow {
  brand: string;
  client_id: string;
  secret_enc: string;
  refused_at: number | null;
}

export class PleosAuthActor {
  private pending: Promise<PleosTokenAnswer> | null = null;

  constructor(
    private readonly storage: ActorStorage,
    private readonly env: AppEnv,
    private readonly fetchImpl?: typeof fetch,
  ) {}

  /**
   * A token for the key held under `account`. `stale` is a token the caller
   * just had refused: the one held is then replaced, unless it is already a
   * newer one than that.
   */
  async token(account: string, stale: string | null = null): Promise<PleosTokenAnswer> {
    const now = Date.now();
    const stored = { ...EMPTY, ...((await this.storage.get<Stored>(STATE)) ?? {}) };
    if (stored.pausedUntil !== null && stored.pausedUntil > now) {
      return { ok: false, kind: "key_shared", retryInMs: stored.pausedUntil - now };
    }
    const held = stored.tokenEnc ? await this.decrypt(stored.tokenEnc) : null;
    if (held && stale !== null && stale === held) {
      // The token EVBook holds was refused before it expired: someone else issued a newer one.
      if (stored.expiresAt > now) {
        stored.refusals = [...stored.refusals.filter((t) => t > now - SHARED_WINDOW_MS), now];
        if (stored.refusals.length >= SHARED_REFUSALS) {
          await this.storage.put(STATE, { ...stored, refusals: [], pausedUntil: now + SHARED_PAUSE_MS });
          return { ok: false, kind: "key_shared", retryInMs: SHARED_PAUSE_MS };
        }
      }
      await this.storage.put(STATE, { ...stored, tokenEnc: null, expiresAt: 0 });
    } else if (held && stored.expiresAt - RENEW_MARGIN_MS > now) {
      return { ok: true, token: held };
    }
    this.pending ??= this.mint(account).finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  /** A token the connect route just issued while checking the key: keep it, rather than issue another. */
  async adopt(token: string, expiresAt: number): Promise<void> {
    await this.storage.put(STATE, {
      ...EMPTY,
      tokenEnc: await encryptString(this.env.ENCRYPTION_KEY, token),
      expiresAt,
    });
  }

  /** Tokens are issued when asked for, never on a clock: nothing to do. (The Node runtime asks every actor.) */
  async alarm(): Promise<void> {}

  /** The key was replaced or removed: forget its token and any rest. */
  async forget(): Promise<void> {
    await this.storage.delete(STATE);
  }

  private async decrypt(enc: string): Promise<string | null> {
    try {
      return await decryptString(this.env.ENCRYPTION_KEY, enc);
    } catch {
      return null;
    }
  }

  private async mint(account: string): Promise<PleosTokenAnswer> {
    const key = await this.env.DB.prepare(
      "SELECT brand, client_id, secret_enc, refused_at FROM pleos_keys WHERE account = ?",
    )
      .bind(account)
      .first<KeyRow>();
    if (!key) return { ok: false, kind: "no_key" };
    if (key.refused_at !== null) return { ok: false, kind: "key_refused" };
    const secret = await this.decrypt(key.secret_enc);
    if (secret === null || !isPleosBrand(key.brand)) {
      // The encryption key changed, or the row is not one this build wrote: as good as no key.
      await this.refuse(account);
      return { ok: false, kind: "key_refused" };
    }
    const result = await new PleosClient(undefined, this.fetchImpl).token(key.brand, key.client_id, secret);
    if (!result.ok) {
      const { kind, status, code, retryInMs } = result.error;
      console.warn(`[pleos] key ${account}: token refused, ${kind} (${status}${code ? ` / ${code}` : ""})`);
      if (kind === "key_refused") {
        await this.refuse(account);
        await this.forget();
        return { ok: false, kind: "key_refused" };
      }
      return { ok: false, kind: kind === "rate_limited" ? "rate_limited" : "unavailable", retryInMs };
    }
    const stored = { ...EMPTY, ...((await this.storage.get<Stored>(STATE)) ?? {}) };
    await this.storage.put(STATE, {
      ...stored,
      tokenEnc: await encryptString(this.env.ENCRYPTION_KEY, result.value.token),
      expiresAt: result.value.expiresAt,
    });
    return { ok: true, token: result.value.token };
  }

  private async refuse(account: string): Promise<void> {
    const now = Date.now();
    await this.env.DB.prepare(
      "UPDATE pleos_keys SET refused_at = ?, refused_reason = 'key_refused', updated_at = ? WHERE account = ?",
    )
      .bind(now, now, account)
      .run();
  }
}
