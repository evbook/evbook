import { decryptString, encryptString } from "../core/crypto";
import { apiHostFromIssuer, issuerFromAccessToken } from "../core/tesla/jwt";
import { refreshTokens } from "../core/tesla/ownerapi";
import type { AppEnv } from "../platform/env";
import type { ActorStorage } from "../platform/ports";
import type { TeslaAuthStatus } from "@shared/api-types";

interface StoredAuth {
  accessEnc: string;
  refreshEnc: string;
  issuer: string;
  expiresAt: number; // epoch ms
  lastRefreshAt: number;
}

const RETRY_DELAY_MS = 5 * 60 * 1000;
const MAX_CONSECUTIVE_FAILURES = 5; // then require a fresh sign-in

/**
 * Singleton actor owning the Tesla token pair — the port of TeslaMate's Api
 * GenServer + ETS cache. Tokens are AES-256-GCM encrypted with ENCRYPTION_KEY;
 * the alarm proactively refreshes at 75% of expires_in. The runtime guarantees
 * calls are serialized (a Durable Object on Cloudflare, a mutex on Node).
 */
export class AuthActor {
  constructor(
    protected readonly storage: ActorStorage,
    protected readonly env: AppEnv,
  ) {}

  /** Validate a pasted token pair by refreshing immediately, then persist it. */
  async signIn(accessToken: string, refreshToken: string): Promise<{ ok: boolean; error?: string }> {
    const issuer = this.env.TESLA_AUTH_ISSUER || issuerFromAccessToken(accessToken);
    const result = await refreshTokens(issuer, refreshToken);
    if (!result.ok) {
      return {
        ok: false,
        error:
          result.error.kind === "unauthorized" ? "Tokens are invalid" : `Token refresh failed (${result.error.kind})`,
      };
    }
    await this.persist(issuer, result.value.access_token, result.value.refresh_token, result.value.expires_in);
    await this.storage.put("failures", 0);
    return { ok: true };
  }

  async signOut(): Promise<void> {
    await this.storage.deleteAll();
    await this.storage.deleteAlarm();
  }

  async status(): Promise<TeslaAuthStatus> {
    const auth = await this.storage.get<StoredAuth>("auth");
    const lastError = (await this.storage.get<string>("lastError")) ?? null;
    return {
      signedIn: auth !== undefined,
      expiresAt: auth?.expiresAt ?? null,
      lastRefreshAt: auth?.lastRefreshAt ?? null,
      lastError,
    };
  }

  /** Current access token, refreshing first if it is (nearly) expired. */
  async getAccessToken(): Promise<string | null> {
    let auth = await this.storage.get<StoredAuth>("auth");
    if (!auth) return null;
    if (auth.expiresAt - Date.now() < 60_000) {
      auth = (await this.refresh(auth)) ?? undefined;
      if (!auth) return null;
    }
    return decryptString(this.env.ENCRYPTION_KEY, auth.accessEnc);
  }

  /**
   * Token, API host and expiry in one call, for a poller that caches the
   * answer. Fetching them separately is two wakes of this actor per poll —
   * and handing out the expiry is what lets the caller stay away until it
   * approaches.
   */
  async getAccessContext(): Promise<{ token: string; apiHost: string; expiresAt: number } | null> {
    const token = await this.getAccessToken();
    if (token === null) return null;
    const auth = await this.storage.get<StoredAuth>("auth");
    if (!auth) return null;
    return { token, apiHost: await this.getApiHost(), expiresAt: auth.expiresAt };
  }

  /** Owner API host for this account's region. */
  async getApiHost(): Promise<string> {
    if (this.env.TESLA_API_HOST) return this.env.TESLA_API_HOST;
    const auth = await this.storage.get<StoredAuth>("auth");
    return apiHostFromIssuer(auth?.issuer ?? "");
  }

  /** Called by a route after a Tesla 401: force one refresh attempt. */
  async forceRefresh(): Promise<boolean> {
    const auth = await this.storage.get<StoredAuth>("auth");
    if (!auth) return false;
    return (await this.refresh(auth)) !== null;
  }

  async alarm(): Promise<void> {
    const auth = await this.storage.get<StoredAuth>("auth");
    if (auth) await this.refresh(auth);
  }

  private async refresh(auth: StoredAuth): Promise<StoredAuth | null> {
    const refreshToken = await decryptString(this.env.ENCRYPTION_KEY, auth.refreshEnc);
    const result = await refreshTokens(auth.issuer, refreshToken);
    if (!result.ok) {
      const failures = ((await this.storage.get<number>("failures")) ?? 0) + 1;
      await this.storage.put("failures", failures);
      await this.storage.put("lastError", `refresh failed: ${result.error.kind}`);
      if (failures >= MAX_CONSECUTIVE_FAILURES && result.error.kind === "unauthorized") {
        // Refresh token is dead — stop trying; the UI shows a sign-in banner.
        await this.storage.delete("auth");
        await this.storage.deleteAlarm();
      } else {
        await this.storage.setAlarm(Date.now() + RETRY_DELAY_MS);
      }
      return null;
    }
    await this.storage.put("failures", 0);
    await this.storage.delete("lastError");
    return this.persist(auth.issuer, result.value.access_token, result.value.refresh_token, result.value.expires_in);
  }

  private async persist(
    issuer: string,
    accessToken: string,
    refreshToken: string,
    expiresInS: number,
  ): Promise<StoredAuth> {
    const key = this.env.ENCRYPTION_KEY;
    const auth: StoredAuth = {
      accessEnc: await encryptString(key, accessToken),
      refreshEnc: await encryptString(key, refreshToken),
      issuer,
      expiresAt: Date.now() + expiresInS * 1000,
      lastRefreshAt: Date.now(),
    };
    await this.storage.put("auth", auth);
    await this.storage.setAlarm(Date.now() + expiresInS * 750); // 75% of expires_in
    // Mirror to the database so a full export includes the (encrypted) tokens.
    await this.env.DB.prepare(
      "INSERT INTO tokens (id, access_enc, refresh_enc, updated_at) VALUES (1, ?, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET access_enc = excluded.access_enc, refresh_enc = excluded.refresh_enc, updated_at = excluded.updated_at",
    )
      .bind(auth.accessEnc, auth.refreshEnc, Date.now())
      .run()
      .catch(() => {}); // mirror is best-effort
    return auth;
  }
}
