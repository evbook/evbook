import { decryptString, encryptString } from "../core/crypto";
import { DEFAULT_API_HOST } from "../core/volvo/api";
import {
  DEFAULT_ISSUER,
  DEFAULT_LINK_URL,
  authorizeUrl,
  checkClientId,
  clientEndpoint,
  exchangeCode,
  linkAuthorizeUrl,
  linkEndpoint,
  parseScopes,
  pkceChallenge,
  randomToken,
  refreshGrant,
  revokeToken,
  type TokenEndpoint,
  type TokenSet,
} from "../core/volvo/oauth";
import type { AppEnv } from "../platform/env";
import type { ActorStorage } from "../platform/ports";
import type { VolvoCredentialsInput, VolvoLinkMode, VolvoStatusDto } from "@shared/api-types";

/**
 * The Volvo ID connection: the API key, how sign-in works, the user's grant,
 * and the authorizations under way.
 *
 * Two ways to sign in. **Linked** (the default): through EVBook's account
 * linking at volvo.evbook.app, which holds EVBook's Volvo application, so the
 * owner brings only an API key. **Own**: the owner's own Volvo application,
 * client ID and secret, talking to Volvo ID directly — for those who want
 * nothing to pass through the project, or an instance with linking turned off. One instance per EVBook — a second named
 * instance of the auth actor's runtime ("volvo"), so it brings no new Durable
 * Object class. Calls are serialized by the runtime, which is what makes the
 * refresh-token rotation safe: two refreshes can never race and lose the new
 * token Volvo issued to one of them.
 */

/** The auth actor instance that holds the Volvo connection. Never a Tesla account's name. */
export const VOLVO_ACCOUNT = "volvo";

interface StoredCreds {
  /** Absent on credentials saved before linking existed: those were all "own". */
  mode?: VolvoLinkMode;
  /** "own" only. */
  clientId: string | null;
  secretEnc: string | null;
  apiKeyEnc: string;
  apiKeyLast4: string;
  scopes: string[];
  updatedAt: number;
}

interface StoredGrant {
  accessEnc: string;
  refreshEnc: string;
  expiresAt: number;
  /** When the refresh token lapses, as Keycloak said; null when it did not say. */
  refreshExpiresAt: number | null;
  /** The user's consent — the grant's start. */
  authorizedAt: number;
  refreshedAt: number;
  scope: string | null;
}

interface PendingFlow {
  verifier: string;
  redirectUri: string;
  expiresAt: number;
}

const CREDS = "volvo:creds";
const GRANT = "volvo:grant";
const REAUTH = "volvo:reauth";
const LAST_ERROR = "volvo:lastError";
const FLOW_PREFIX = "volvo:flow:";

/** Refresh this long before the access token expires. */
const REFRESH_MARGIN_MS = 2 * 60_000;
/** Refresh an idle grant at least this often, so it does not lapse unused. */
const KEEPALIVE_MS = 24 * 60 * 60_000;
const RETRY_MS = 5 * 60_000;
const CLIENT_RETRY_MS = 60 * 60_000;
const FLOW_TTL_MS = 10 * 60_000;
/**
 * Volvo documents a grant lasting at most three months, however often it is
 * refreshed (and refresh tokens of 90 days were seen on 2026-11-12); warn two
 * weeks ahead.
 */
const GRANT_AGING_MS = 75 * 24 * 60 * 60_000;
const MAX_FLOWS = 5;

export type VolvoAccess = { token: string; apiKey: string; apiHost: string; expiresAt: number };

export class VolvoAuthActor {
  constructor(
    protected readonly storage: ActorStorage,
    protected readonly env: AppEnv,
  ) {}

  private issuer(): string {
    return (this.env.VOLVO_AUTH_ISSUER || DEFAULT_ISSUER).replace(/\/+$/, "");
  }

  /** EVBook's account-linking service, or null where it is turned off. */
  private linkUrl(): string | null {
    const configured = this.env.VOLVO_LINK_URL.trim();
    if (configured === "off") return null;
    return (configured || DEFAULT_LINK_URL).replace(/\/+$/, "");
  }

  private apiHost(): string {
    return (this.env.VOLVO_API_HOST || DEFAULT_API_HOST).replace(/\/+$/, "");
  }

  /** Whether this instance is the Volvo one — the shared shell's alarm asks. */
  async owns(): Promise<boolean> {
    return (await this.storage.get(CREDS)) !== undefined || (await this.storage.get(GRANT)) !== undefined;
  }

  async status(): Promise<VolvoStatusDto> {
    const creds = await this.storage.get<StoredCreds>(CREDS);
    const grant = await this.storage.get<StoredGrant>(GRANT);
    const reauth = await this.storage.get<{ at: number; reason: string }>(REAUTH);
    return {
      configured: creds !== undefined,
      mode: creds ? (creds.mode ?? "own") : this.linkUrl() ? "linked" : "own",
      linkUrl: this.linkUrl(),
      clientId: creds?.clientId ?? null,
      apiKeyLast4: creds?.apiKeyLast4 ?? null,
      scopes: creds?.scopes ?? parseScopesOrDefault(),
      connected: grant !== undefined,
      authorizedAt: grant?.authorizedAt ?? null,
      grantAging: grant ? Date.now() - grant.authorizedAt > GRANT_AGING_MS : false,
      accessExpiresAt: grant?.expiresAt ?? null,
      refreshExpiresAt: grant?.refreshExpiresAt ?? null,
      grantedScope: grant?.scope ?? null,
      reauthReason: grant ? null : (reauth?.reason ?? null),
      lastError: (await this.storage.get<string>(LAST_ERROR)) ?? null,
    };
  }

  /**
   * Save how this EVBook signs in to Volvo, and the API key. The secret and the
   * key may be left out on a later save to keep the stored ones — the page
   * never gets them back to resubmit. A change of client (another client ID,
   * or between linked and own) drops the grant: it was issued to the old one.
   */
  async setCredentials(input: VolvoCredentialsInput): Promise<{ ok: boolean; error?: string }> {
    const existing = await this.storage.get<StoredCreds>(CREDS);
    const mode: VolvoLinkMode = input.mode ?? (input.clientId ? "own" : "linked");
    const apiKey = (input.apiKey ?? "").trim();
    if (!apiKey && !existing) return { ok: false, error: "The API key (vcc-api-key) is required." };
    const key = this.env.ENCRYPTION_KEY;
    const apiKeyEnc = apiKey ? await encryptString(key, apiKey) : existing!.apiKeyEnc;
    const apiKeyLast4 = apiKey ? apiKey.slice(-4) : existing!.apiKeyLast4;

    let creds: StoredCreds;
    if (mode === "linked") {
      if (!this.linkUrl())
        return { ok: false, error: "Account linking is turned off on this EVBook; use your own Volvo application." };
      creds = { mode, clientId: null, secretEnc: null, apiKeyEnc, apiKeyLast4, scopes: [], updatedAt: Date.now() };
    } else {
      const clientId = (input.clientId ?? existing?.clientId ?? "").trim();
      const idError = checkClientId(clientId);
      if (idError) return { ok: false, error: idError };
      const secret = (input.clientSecret ?? "").trim();
      const keepSecret = existing?.clientId === clientId ? existing.secretEnc : null;
      if (!secret && !keepSecret) return { ok: false, error: "The client secret is required." };
      const scopes = parseScopes(input.scopes ?? (existing?.scopes.length ? existing.scopes : null));
      if ("error" in scopes) return { ok: false, error: scopes.error };
      creds = {
        mode,
        clientId,
        secretEnc: secret ? await encryptString(key, secret) : keepSecret,
        apiKeyEnc,
        apiKeyLast4,
        scopes: scopes.scopes,
        updatedAt: Date.now(),
      };
    }
    if (existing && ((existing.mode ?? "own") !== mode || existing.clientId !== creds.clientId)) {
      await this.disconnect();
      await this.dropGrant("client_changed");
    }
    await this.storage.put(CREDS, creds);
    await this.storage.delete(LAST_ERROR);
    return { ok: true };
  }

  /** Forget the application and the grant (revoked at Volvo first). */
  async clearCredentials(): Promise<void> {
    await this.disconnect();
    await this.storage.deleteAll();
    await this.storage.deleteAlarm();
  }

  /** Start a consent: a single-use state and a PKCE verifier kept here, never sent. */
  async beginAuthorization(
    redirectUri: string,
  ): Promise<{ ok: true; url: string; state: string } | { ok: false; error: string }> {
    const creds = await this.storage.get<StoredCreds>(CREDS);
    if (!creds) return { ok: false, error: "Save the Volvo API key first." };
    const link = this.linkUrl();
    if ((creds.mode ?? "own") === "linked" && !link) return { ok: false, error: "Account linking is turned off." };
    await this.pruneFlows();
    const state = randomToken(24);
    const verifier = randomToken(48);
    await this.storage.put(FLOW_PREFIX + state, {
      verifier,
      redirectUri,
      expiresAt: Date.now() + FLOW_TTL_MS,
    } satisfies PendingFlow);
    const challenge = await pkceChallenge(verifier);
    const url =
      (creds.mode ?? "own") === "linked"
        ? linkAuthorizeUrl({ linkUrl: link!, returnUri: redirectUri, state, challenge })
        : authorizeUrl({
            issuer: this.issuer(),
            clientId: creds.clientId!,
            redirectUri,
            scopes: creds.scopes,
            state,
            challenge,
          });
    return { ok: true, url, state };
  }

  /** Finish a consent: the flow must exist, be fresh, and is used up either way. */
  async completeAuthorization(state: string, code: string): Promise<{ ok: boolean; error?: string }> {
    const flowKey = FLOW_PREFIX + state;
    const flow = await this.storage.get<PendingFlow>(flowKey);
    await this.storage.delete(flowKey);
    if (!flow || flow.expiresAt < Date.now()) {
      return { ok: false, error: "This sign-in has expired or was already used. Start again from Settings." };
    }
    const client = await this.endpoint();
    if (!client) return { ok: false, error: "The Volvo credentials are missing." };
    // Through the linking service the redirect URI is its own, and it adds it.
    const result = await exchangeCode(client.endpoint, {
      code,
      redirectUri: client.linked ? null : flow.redirectUri,
      verifier: flow.verifier,
    });
    if (!result.ok) {
      await this.storage.put(LAST_ERROR, `sign-in failed: ${result.error.message}`);
      return {
        ok: false,
        error:
          result.error.kind === "invalid_client"
            ? "Volvo refused the client ID or secret."
            : `Volvo did not issue tokens (${result.error.message}).`,
      };
    }
    if (!result.value.refreshToken) {
      return { ok: false, error: "Volvo issued no refresh token, so EVBook could not keep reading the car." };
    }
    const now = Date.now();
    await this.persist(result.value, null, now);
    await this.storage.delete(REAUTH);
    await this.storage.delete(LAST_ERROR);
    return { ok: true };
  }

  /** Token, key and host for a poll; refreshes first when the token is nearly due. */
  async getAccessContext(): Promise<VolvoAccess | null> {
    const creds = await this.storage.get<StoredCreds>(CREDS);
    let grant = await this.storage.get<StoredGrant>(GRANT);
    if (!creds || !grant) return null;
    if (grant.expiresAt - Date.now() < REFRESH_MARGIN_MS) {
      grant = (await this.refresh(grant)) ?? undefined;
      if (!grant) return null;
    }
    const key = this.env.ENCRYPTION_KEY;
    return {
      token: await decryptString(key, grant.accessEnc),
      apiKey: await decryptString(key, creds.apiKeyEnc),
      apiHost: this.apiHost(),
      expiresAt: grant.expiresAt,
    };
  }

  /** After a 401 from the API: one refresh, whatever the clock says. */
  async forceRefresh(): Promise<boolean> {
    const grant = await this.storage.get<StoredGrant>(GRANT);
    if (!grant) return false;
    return (await this.refresh(grant)) !== null;
  }

  /** Revoke at Volvo, forget here. The credentials stay, so reconnecting is one click. */
  async disconnect(): Promise<void> {
    const grant = await this.storage.get<StoredGrant>(GRANT);
    const client = await this.endpoint();
    if (grant && client) {
      await revokeToken(
        client.endpoint,
        await decryptString(this.env.ENCRYPTION_KEY, grant.refreshEnc).catch(() => ""),
      );
    }
    await this.storage.delete(GRANT);
    await this.storage.delete(REAUTH);
    await this.storage.deleteAlarm();
  }

  async alarm(): Promise<void> {
    const grant = await this.storage.get<StoredGrant>(GRANT);
    if (grant) await this.refresh(grant);
  }

  /** Where tokens come from: the linking service, or Volvo ID with the owner's own client. */
  private async endpoint(): Promise<{ endpoint: TokenEndpoint; linked: boolean } | null> {
    const creds = await this.storage.get<StoredCreds>(CREDS);
    if (!creds) return null;
    if ((creds.mode ?? "own") === "linked") {
      const link = this.linkUrl();
      return link ? { endpoint: linkEndpoint(link), linked: true } : null;
    }
    if (!creds.clientId || !creds.secretEnc) return null;
    return {
      endpoint: clientEndpoint({
        issuer: this.issuer(),
        clientId: creds.clientId,
        clientSecret: await decryptString(this.env.ENCRYPTION_KEY, creds.secretEnc),
      }),
      linked: false,
    };
  }

  private async refresh(grant: StoredGrant): Promise<StoredGrant | null> {
    const client = await this.endpoint();
    if (!client) return null;
    const refreshToken = await decryptString(this.env.ENCRYPTION_KEY, grant.refreshEnc);
    const result = await refreshGrant(client.endpoint, refreshToken);
    if (!result.ok) {
      await this.storage.put(LAST_ERROR, `refresh failed: ${result.error.message}`);
      if (result.error.kind === "invalid_grant") {
        // The only answer that means the consent is gone. Anything else — a 5xx,
        // a timeout, a refused secret — leaves the grant for the next attempt.
        await this.dropGrant("grant_expired");
      } else {
        await this.storage.setAlarm(Date.now() + (result.error.kind === "invalid_client" ? CLIENT_RETRY_MS : RETRY_MS));
      }
      return null;
    }
    await this.storage.delete(LAST_ERROR);
    return this.persist(result.value, grant, Date.now());
  }

  private async persist(tokens: TokenSet, previous: StoredGrant | null, now: number): Promise<StoredGrant> {
    console.log(`[volvo] tokens issued: ${describeToken(tokens)}`);
    const key = this.env.ENCRYPTION_KEY;
    const grant: StoredGrant = {
      accessEnc: await encryptString(key, tokens.accessToken),
      // Volvo rotates; a response without a new refresh token keeps the old one.
      refreshEnc: tokens.refreshToken ? await encryptString(key, tokens.refreshToken) : previous!.refreshEnc,
      expiresAt: now + tokens.expiresInS * 1000,
      refreshExpiresAt: tokens.refreshExpiresInS ? now + tokens.refreshExpiresInS * 1000 : null,
      authorizedAt: previous?.authorizedAt ?? now,
      refreshedAt: now,
      scope: tokens.scope ?? previous?.scope ?? null,
    };
    await this.storage.put(GRANT, grant);
    await this.storage.setAlarm(keepAliveAt(grant, now));
    return grant;
  }

  private async dropGrant(reason: string): Promise<void> {
    await this.storage.delete(GRANT);
    await this.storage.put(REAUTH, { at: Date.now(), reason });
    await this.storage.deleteAlarm();
  }

  private async pruneFlows(): Promise<void> {
    const flows = await this.storage.list<PendingFlow>({ prefix: FLOW_PREFIX });
    const now = Date.now();
    const live = [...flows].filter(([, f]) => f.expiresAt >= now).sort((a, b) => a[1].expiresAt - b[1].expiresAt);
    const stale = [...flows].filter(([, f]) => f.expiresAt < now).map(([k]) => k);
    while (live.length >= MAX_FLOWS) stale.push(live.shift()![0]);
    if (stale.length) await this.storage.delete(stale);
  }
}

/**
 * When to refresh an idle grant: well before the refresh token lapses, and at
 * least daily. Polling refreshes on its own whenever the access token runs out;
 * this is for the grant nothing is reading (logging off, the car disabled).
 */
export function keepAliveAt(grant: Pick<StoredGrant, "refreshExpiresAt">, now: number): number {
  if (grant.refreshExpiresAt === null) return now + KEEPALIVE_MS;
  const life = grant.refreshExpiresAt - now;
  const early = Math.max(REFRESH_MARGIN_MS, life * 0.2);
  return Math.max(now + 60_000, Math.min(now + KEEPALIVE_MS, grant.refreshExpiresAt - early));
}

function parseScopesOrDefault(): string[] {
  const parsed = parseScopes(null);
  return "scopes" in parsed ? parsed.scopes : [];
}

/** Claims that say which client, market and scopes Volvo issued a token for. Never the token or the user. */
const LOGGED_CLAIMS = ["azp", "market", "client_region", "client_type", "acr", "scope"] as const;

/**
 * What a token was issued for, for the log: Volvo decides which markets it
 * serves from the sign-in client, and a token's own claims (`market`, `azp`)
 * are the quickest way to see why a car is refused. The token is never logged.
 */
export function describeToken(tokens: Pick<TokenSet, "accessToken" | "expiresInS" | "refreshExpiresInS">): string {
  const parts = [`expires_in=${tokens.expiresInS}`, `refresh_expires_in=${tokens.refreshExpiresInS ?? "none"}`];
  try {
    const payload = tokens.accessToken.split(".")[1];
    if (payload) {
      const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((payload.length + 3) % 4));
      const claims = JSON.parse(json) as Record<string, unknown>;
      for (const name of LOGGED_CLAIMS) {
        if (claims[name] !== undefined) parts.push(`${name}=${JSON.stringify(claims[name])}`);
      }
    }
  } catch {
    parts.push("claims=unreadable");
  }
  return parts.join(" ");
}
