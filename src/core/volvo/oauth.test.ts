import { describe, expect, it } from "bun:test";
import { FAKE_CLIENT, FAKE_ISSUER, FakeVolvo } from "../../../test/fake-volvo";
import {
  DEFAULT_SCOPES,
  authorizeUrl,
  checkClientId,
  exchangeCode,
  parseScopes,
  pkceChallenge,
  randomToken,
  refreshGrant,
  revokeToken,
} from "./oauth";

const client = { issuer: FAKE_ISSUER, clientId: FAKE_CLIENT.clientId, clientSecret: FAKE_CLIENT.clientSecret };
const REDIRECT = "https://evbook.example/api/v1/auth/volvo/callback";

async function consented(fake: FakeVolvo) {
  const verifier = randomToken(48);
  const url = authorizeUrl({
    issuer: FAKE_ISSUER,
    clientId: FAKE_CLIENT.clientId,
    redirectUri: REDIRECT,
    scopes: DEFAULT_SCOPES,
    state: "s1",
    challenge: await pkceChallenge(verifier),
  });
  return { verifier, url, ...fake.consent(url) };
}

describe("client id and scopes", () => {
  it("accepts only the new Volvo ID's clients, and says what to do about an old one", () => {
    expect(checkClientId("vid-dc-abc")).toBeNull();
    expect(checkClientId("dc-abc")).toContain("31 January 2027");
    expect(checkClientId("")).not.toBeNull();
    expect(checkClientId("something")).not.toBeNull();
  });

  it("defaults to the read-only list, and refuses a list that could act on the car", () => {
    expect(parseScopes("")).toEqual({ scopes: [...DEFAULT_SCOPES] });
    expect(parseScopes("openid energy:state:read, location:read")).toEqual({
      scopes: ["openid", "energy:state:read", "location:read"],
    });
    expect(parseScopes("energy:state:read")).toEqual({ error: "The scopes must include openid." });
    expect(parseScopes("openid conve:unlock")).toHaveProperty("error");
    expect(DEFAULT_SCOPES).not.toContain("offline_access");
  });
});

describe("authorization", () => {
  it("builds the Keycloak authorization request with PKCE S256", async () => {
    const challenge = await pkceChallenge("verifier");
    const url = new URL(
      authorizeUrl({
        issuer: FAKE_ISSUER,
        clientId: "vid-dc-x",
        redirectUri: REDIRECT,
        scopes: ["openid", "a"],
        state: "st",
        challenge,
      }),
    );
    expect(url.origin + url.pathname).toBe(`${FAKE_ISSUER}/protocol/openid-connect/auth`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: "vid-dc-x",
      redirect_uri: REDIRECT,
      scope: "openid a",
      state: "st",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    // RFC 7636 appendix B.
    expect(await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("exchanges the code once, with Basic client auth and the verifier", async () => {
    const fake = new FakeVolvo();
    const { verifier, code } = await consented(fake);
    const first = await exchangeCode(client, { code, redirectUri: REDIRECT, verifier }, fake.fetch);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.expiresInS).toBe(1799);
    expect(first.value.refreshExpiresInS).toBe(7 * 24 * 3600);
    expect(first.value.refreshToken).toMatch(/^refresh-/);
    const again = await exchangeCode(client, { code, redirectUri: REDIRECT, verifier }, fake.fetch);
    expect(again).toEqual({ ok: false, error: { kind: "invalid_grant", message: "invalid_grant: Code not valid" } });
  });

  it("refuses a wrong verifier and a wrong secret, and says which", async () => {
    const fake = new FakeVolvo();
    const { code } = await consented(fake);
    const wrong = await exchangeCode(client, { code, redirectUri: REDIRECT, verifier: "nope" }, fake.fetch);
    expect(!wrong.ok && wrong.error.kind).toBe("invalid_grant");
    const { code: code2, verifier } = await consented(fake);
    const badSecret = await exchangeCode(
      { ...client, clientSecret: "x" },
      { code: code2, redirectUri: REDIRECT, verifier },
      fake.fetch,
    );
    expect(!badSecret.ok && badSecret.error.kind).toBe("invalid_client");
  });
});

describe("refresh", () => {
  it("rotates the refresh token, and the old one is then spent", async () => {
    const fake = new FakeVolvo();
    const { verifier, code } = await consented(fake);
    const issued = await exchangeCode(client, { code, redirectUri: REDIRECT, verifier }, fake.fetch);
    if (!issued.ok) throw new Error("exchange failed");
    const first = issued.value.refreshToken!;
    const rotated = await refreshGrant(client, first, fake.fetch);
    expect(rotated.ok && rotated.value.refreshToken).not.toBe(first);
    const reused = await refreshGrant(client, first, fake.fetch);
    expect(reused).toEqual({
      ok: false,
      error: { kind: "invalid_grant", message: "invalid_grant: refresh token already used" },
    });
  });

  it("calls a 5xx or an unreadable answer transient, never a lost grant", async () => {
    const down = async () => new Response("bad gateway", { status: 502 });
    expect(await refreshGrant(client, "r", down)).toEqual({
      ok: false,
      error: { kind: "transient", message: "HTTP 502" },
    });
    const garbled = async () => Response.json({ token_type: "Bearer" });
    const result = await refreshGrant(client, "r", garbled);
    expect(!result.ok && result.error.kind).toBe("transient");
    const thrown = async (): Promise<Response> => {
      throw new TypeError("network down");
    };
    expect(!(await refreshGrant(client, "r", thrown)).ok).toBe(true);
  });

  it("keeps an absent refresh token absent, so the caller holds on to its own", async () => {
    const noRotation = async () => Response.json({ access_token: "a", expires_in: 299, refresh_expires_in: 0 });
    const result = await refreshGrant(client, "r", noRotation);
    expect(result).toEqual({
      ok: true,
      value: { accessToken: "a", refreshToken: null, expiresInS: 299, refreshExpiresInS: null, scope: null },
    });
  });

  it("revokes at Volvo ID", async () => {
    const fake = new FakeVolvo();
    const { verifier, code } = await consented(fake);
    const issued = await exchangeCode(client, { code, redirectUri: REDIRECT, verifier }, fake.fetch);
    if (!issued.ok) throw new Error("exchange failed");
    expect(await revokeToken(client, issued.value.refreshToken!, fake.fetch)).toBe(true);
    const after = await refreshGrant(client, issued.value.refreshToken!, fake.fetch);
    expect(!after.ok && after.error.kind).toBe("invalid_grant");
  });
});
