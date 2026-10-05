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

/** Derive the OAuth issuer URL from an access token's `iss` claim (handles EU/CN accounts). */
export function issuerFromAccessToken(accessToken: string): string {
  const payload = decodeJwtPayload(accessToken);
  const iss = payload?.iss;
  if (typeof iss === "string" && iss.startsWith("https://")) return iss.replace(/\/$/, "");
  return DEFAULT_ISSUER;
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
