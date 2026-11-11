import { isTimeout, withDeadline } from "../deadline";

/**
 * Volvo ID: OAuth 2.0 authorization code with PKCE (S256), client
 * authentication as HTTP Basic at the token endpoint, refresh-token rotation.
 *
 * Only the Keycloak realm is supported. Volvo is retiring the old Volvo ID
 * (client ids starting `dc-`) on 31 January 2027; applications published since
 * get a `vid-dc-` client id on this realm, a new secret and a new API key
 * (https://developer.volvocars.com/news/volvoid-migration/).
 */

export const DEFAULT_ISSUER = "https://auth.volvocars.com/realms/volvocars";

/**
 * What EVBook reads, and nothing that could act on the car. `openid` is
 * mandatory. `offline_access` is deliberately absent: Keycloak refuses the whole
 * request (`invalid_scope`) for a scope the application was not published with,
 * so it is only sent when the owner adds it to their list.
 */
export const DEFAULT_SCOPES = [
  "openid",
  "conve:vehicle_relation",
  "conve:engine_status",
  "conve:odometer_status",
  "conve:trip_statistics",
  "conve:diagnostics_workshop",
  "conve:brake_status",
  "conve:diagnostics_engine_status",
  "conve:tyre_status",
  "conve:warnings",
  "conve:doors_status",
  "conve:lock_status",
  "conve:windows_status",
  "energy:state:read",
  "energy:capability:read",
  "location:read",
] as const;

/** Scopes that can move the car or change its state. A logger never holds one. */
const COMMAND_SCOPES = new Set([
  "conve:lock",
  "conve:unlock",
  "conve:engine_start_stop",
  "conve:honk_flash",
  "conve:climatization_start_stop",
  "conve:commands",
  "conve:navigation",
  "vehicle:unlock",
  "vehicle:lock",
  "vehicle:engine_start",
  "vehicle:honk_blink",
  "vehicle:climatization",
  "energy_device:wallbox:control",
]);

/** Space- or comma-separated scopes, checked; the error says what to fix. */
export function parseScopes(
  input: string | readonly string[] | null | undefined,
): { scopes: string[] } | { error: string } {
  const list = (typeof input === "string" ? input.split(/[\s,]+/) : [...(input ?? [])])
    .map((s) => s.trim())
    .filter(Boolean);
  const scopes = list.length ? [...new Set(list)] : [...DEFAULT_SCOPES];
  if (!scopes.includes("openid")) return { error: "The scopes must include openid." };
  const command = scopes.find((s) => COMMAND_SCOPES.has(s));
  if (command) return { error: `EVBook only reads; remove the command scope ${command}.` };
  return { scopes };
}

/** The client id is checked before anything is sent to Volvo. */
export function checkClientId(clientId: string): string | null {
  if (!clientId) return "The client ID is required.";
  if (clientId.startsWith("dc-")) {
    return "This is an old Volvo ID client (dc-…), which stops working on 31 January 2027. Create a new application on the developer portal: its client ID starts with vid-dc-.";
  }
  if (!clientId.startsWith("vid-")) return "A Volvo ID client ID starts with vid-dc-.";
  return null;
}

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomToken(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

export function authorizeUrl(opts: {
  issuer: string;
  clientId: string;
  redirectUri: string;
  scopes: readonly string[];
  state: string;
  challenge: string;
}): string {
  const url = new URL(`${opts.issuer}/protocol/openid-connect/auth`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", opts.clientId);
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("scope", opts.scopes.join(" "));
  url.searchParams.set("state", opts.state);
  url.searchParams.set("code_challenge", opts.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export interface TokenSet {
  accessToken: string;
  /** Absent when the server chose not to rotate: keep the one you have. */
  refreshToken: string | null;
  expiresInS: number;
  /** Keycloak says how long the refresh token lives; null when it does not. */
  refreshExpiresInS: number | null;
  scope: string | null;
}

export type TokenError =
  /** RFC 6749 invalid_grant: the grant is gone. Only this means "connect again". */
  | { kind: "invalid_grant"; message: string }
  /** The client id or secret was refused. The grant may be fine; fix the credentials. */
  | { kind: "invalid_client"; message: string }
  /** 5xx, a timeout, an unreadable answer: try again later, the grant is intact. */
  | { kind: "transient"; message: string };

export type TokenResult = { ok: true; value: TokenSet } | { ok: false; error: TokenError };

export interface ClientAuth {
  issuer: string;
  clientId: string;
  clientSecret: string;
}

/**
 * Where tokens are asked for, and how the asker proves it is the client. With
 * the owner's own application that is Volvo ID itself and the client's secret;
 * with EVBook's account linking it is volvo.evbook.app, which adds the secret
 * of EVBook's application on the way through, so the instance sends none.
 */
export interface TokenEndpoint {
  tokenUrl: string;
  revokeUrl: string;
  /** The Authorization header value, or null when the endpoint adds its own. */
  authorization: string | null;
}

/** EVBook's account-linking service; `VOLVO_LINK_URL` overrides it, "off" disables it. */
export const DEFAULT_LINK_URL = "https://volvo.evbook.app";

export function clientEndpoint(client: ClientAuth): TokenEndpoint {
  return {
    tokenUrl: `${client.issuer}/protocol/openid-connect/token`,
    revokeUrl: `${client.issuer}/protocol/openid-connect/revoke`,
    // Basic, always: never retried with the secret in the body.
    authorization: `Basic ${btoa(`${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret)}`)}`,
  };
}

export function linkEndpoint(linkUrl: string): TokenEndpoint {
  return { tokenUrl: `${linkUrl}/token`, revokeUrl: `${linkUrl}/revoke`, authorization: null };
}

/**
 * The account-linking start: the browser goes to the linking service with this
 * instance's callback, its state and its PKCE challenge, and comes back to the
 * callback with a code. The scopes are the linking application's, not ours.
 */
export function linkAuthorizeUrl(opts: {
  linkUrl: string;
  returnUri: string;
  state: string;
  challenge: string;
}): string {
  const url = new URL(`${opts.linkUrl}/authorize`);
  url.searchParams.set("return", opts.returnUri);
  url.searchParams.set("state", opts.state);
  url.searchParams.set("code_challenge", opts.challenge);
  return url.toString();
}

const TOKEN_TIMEOUT_MS = 30_000;

function formHeaders(endpoint: TokenEndpoint): Record<string, string> {
  return {
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json",
    ...(endpoint.authorization ? { authorization: endpoint.authorization } : {}),
  };
}

async function tokenRequest(
  endpoint: TokenEndpoint,
  form: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<TokenResult> {
  try {
    return await withDeadline(TOKEN_TIMEOUT_MS, async (signal) => {
      const res = await fetchImpl(endpoint.tokenUrl, {
        method: "POST",
        headers: formHeaders(endpoint),
        body: new URLSearchParams(form).toString(),
        signal,
      });
      const text = await res.text();
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(text) as Record<string, unknown>;
      } catch {
        // Leave it empty: the status decides below.
      }
      if (!res.ok) {
        const code = typeof body.error === "string" ? body.error : "";
        const message =
          [code, typeof body.error_description === "string" ? body.error_description : ""].filter(Boolean).join(": ") ||
          `HTTP ${res.status}`;
        if (code === "invalid_grant") return { ok: false, error: { kind: "invalid_grant", message } };
        if (code === "invalid_client" || code === "unauthorized_client" || res.status === 401) {
          return { ok: false, error: { kind: "invalid_client", message } };
        }
        return { ok: false, error: { kind: "transient", message } };
      }
      const access = body.access_token;
      const expires = Number(body.expires_in);
      if (typeof access !== "string" || !access || !Number.isFinite(expires) || expires <= 0) {
        return { ok: false, error: { kind: "transient", message: "token response without access_token/expires_in" } };
      }
      const refreshExpires = Number(body.refresh_expires_in);
      return {
        ok: true,
        value: {
          accessToken: access,
          refreshToken: typeof body.refresh_token === "string" && body.refresh_token ? body.refresh_token : null,
          expiresInS: expires,
          // Keycloak reports 0 for an offline token, which does not expire on a clock.
          refreshExpiresInS: Number.isFinite(refreshExpires) && refreshExpires > 0 ? refreshExpires : null,
          scope: typeof body.scope === "string" ? body.scope : null,
        },
      };
    });
  } catch (error) {
    return {
      ok: false,
      error: {
        kind: "transient",
        message: isTimeout(error) ? "timed out" : error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/** `redirectUri` null through the linking service, which adds its own. */
export function exchangeCode(
  endpoint: TokenEndpoint,
  opts: { code: string; redirectUri: string | null; verifier: string },
  fetchImpl: typeof fetch = (...a) => fetch(...a),
): Promise<TokenResult> {
  return tokenRequest(
    endpoint,
    {
      grant_type: "authorization_code",
      code: opts.code,
      ...(opts.redirectUri ? { redirect_uri: opts.redirectUri } : {}),
      code_verifier: opts.verifier,
    },
    fetchImpl,
  );
}

export function refreshGrant(
  endpoint: TokenEndpoint,
  refreshToken: string,
  fetchImpl: typeof fetch = (...a) => fetch(...a),
): Promise<TokenResult> {
  return tokenRequest(endpoint, { grant_type: "refresh_token", refresh_token: refreshToken }, fetchImpl);
}

/** Best effort: a revocation that fails still leaves the tokens deleted here. */
export async function revokeToken(
  endpoint: TokenEndpoint,
  token: string,
  fetchImpl: typeof fetch = (...a) => fetch(...a),
): Promise<boolean> {
  try {
    return await withDeadline(TOKEN_TIMEOUT_MS, async (signal) => {
      const res = await fetchImpl(endpoint.revokeUrl, {
        method: "POST",
        headers: formHeaders(endpoint),
        body: new URLSearchParams({ token, token_type_hint: "refresh_token" }).toString(),
        signal,
      });
      await res.text();
      return res.ok;
    });
  } catch {
    return false;
  }
}
