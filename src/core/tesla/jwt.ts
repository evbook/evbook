/** Decode a JWT payload without verification (we only need the `iss` claim). */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length < 2 || !parts[1]) return null;
  try {
    const b64 = parts[1].replaceAll("-", "+").replaceAll("_", "/");
    const json = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "="));
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const DEFAULT_ISSUER = "https://auth.tesla.com/oauth2/v3";

/**
 * The hosts Tesla issues Owner API tokens from: the global one and China's.
 * The token is pasted by whoever is signed in and nothing verifies its
 * signature, so its `iss` is only trusted to pick between these — any other
 * host would have the server POST the refresh token wherever the claim says.
 */
const TESLA_ISSUER_HOSTS = new Set(["auth.tesla.com", "auth.tesla.cn"]);

/**
 * `issuer` when it is an `https://` URL on one of Tesla's issuer hosts,
 * normalised to origin and path without a trailing slash; the global issuer
 * otherwise. `TESLA_AUTH_ISSUER` is the way to point the app anywhere else.
 */
export function teslaIssuer(issuer: unknown): string {
  if (typeof issuer !== "string") return DEFAULT_ISSUER;
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    return DEFAULT_ISSUER;
  }
  // `host` rather than `hostname`, so an explicit port is refused too; and
  // the URL parser has already moved anything before an `@` out of the host.
  if (url.protocol !== "https:" || !TESLA_ISSUER_HOSTS.has(url.host)) return DEFAULT_ISSUER;
  return `${url.origin}${url.pathname}`.replace(/\/$/, "");
}

/** Derive the OAuth issuer URL from an access token's `iss` claim (handles EU/CN accounts). */
export function issuerFromAccessToken(accessToken: string): string {
  return teslaIssuer(decodeJwtPayload(accessToken)?.iss);
}

/** Map the issuer to the Owner API host (China accounts use a separate cloud). */
export function apiHostFromIssuer(issuer: string): string {
  try {
    const host = new URL(issuer).host;
    if (host.endsWith(".cn")) return "https://owner-api.vn.cloud.tesla.cn";
  } catch {
    // fall through to default
  }
  return "https://owner-api.teslamotors.com";
}
