import { describe, expect, it } from "bun:test";
import { describeToken, keepAliveAt } from "./volvoAuth";

function jwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${b64({ alg: "RS256" })}.${b64(claims)}.signature`;
}

describe("describeToken", () => {
  it("names the client, market and scopes, and nothing that identifies the user or the token", () => {
    const token = jwt({
      azp: "vid-dcr-x",
      market: "CY",
      sub: "user-123",
      scope: "openid energy:state:read",
      email: "a@b.c",
    });
    const line = describeToken({ accessToken: token, expiresInS: 300, refreshExpiresInS: 7_776_000 });
    expect(line).toBe(
      'expires_in=300 refresh_expires_in=7776000 azp="vid-dcr-x" market="CY" scope="openid energy:state:read"',
    );
    expect(line).not.toContain("user-123");
    expect(line).not.toContain("a@b.c");
    expect(line).not.toContain("signature");
  });

  it("copes with a token that is not a JWT", () => {
    expect(describeToken({ accessToken: "opaque", expiresInS: 60, refreshExpiresInS: null })).toBe(
      "expires_in=60 refresh_expires_in=none",
    );
  });
});

describe("keepAliveAt", () => {
  const now = 1_000_000_000_000;
  it("renews well before the refresh token lapses, and at least daily", () => {
    expect(keepAliveAt({ refreshExpiresAt: null }, now)).toBe(now + 24 * 3600_000);
    expect(keepAliveAt({ refreshExpiresAt: now + 90 * 24 * 3600_000 }, now)).toBe(now + 24 * 3600_000);
    expect(keepAliveAt({ refreshExpiresAt: now + 30 * 60_000 }, now)).toBe(now + 24 * 60_000);
  });
});
