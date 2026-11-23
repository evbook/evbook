import { describe, expect, it } from "bun:test";
import { apiHostFromIssuer, issuerFromAccessToken, teslaIssuer } from "./jwt";

function fakeJwt(payload: object): string {
  const b64 = btoa(JSON.stringify(payload)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  return `eyJhbGciOiJSUzI1NiJ9.${b64}.sig`;
}

describe("issuer derivation", () => {
  it("uses the iss claim", () => {
    const token = fakeJwt({ iss: "https://auth.tesla.com/oauth2/v3" });
    expect(issuerFromAccessToken(token)).toBe("https://auth.tesla.com/oauth2/v3");
  });

  it("strips trailing slash", () => {
    const token = fakeJwt({ iss: "https://auth.tesla.cn/oauth2/v3/" });
    expect(issuerFromAccessToken(token)).toBe("https://auth.tesla.cn/oauth2/v3");
  });

  it("falls back on garbage", () => {
    expect(issuerFromAccessToken("not-a-jwt")).toBe("https://auth.tesla.com/oauth2/v3");
  });

  it("falls back when the claim names a host that is not Tesla's", () => {
    for (const iss of [
      "https://evil.example/oauth2/v3",
      "https://auth.tesla.com.evil.example/oauth2/v3",
      "https://evil.example.auth.tesla.com/oauth2/v3",
      "https://auth.tesla.com@evil.example/oauth2/v3",
      "https://auth.tesla.com:8443/oauth2/v3",
      "http://auth.tesla.com/oauth2/v3",
      "https://169.254.169.254/latest",
    ]) {
      expect(issuerFromAccessToken(fakeJwt({ iss })), iss).toBe("https://auth.tesla.com/oauth2/v3");
    }
  });

  it("keeps Tesla's path but drops a query or fragment", () => {
    expect(teslaIssuer("https://auth.tesla.com/oauth2/v3?x=1#y")).toBe("https://auth.tesla.com/oauth2/v3");
    expect(teslaIssuer("https://AUTH.TESLA.CN/oauth2/v3")).toBe("https://auth.tesla.cn/oauth2/v3");
  });

  it("falls back when the claim is not a string", () => {
    expect(teslaIssuer(42)).toBe("https://auth.tesla.com/oauth2/v3");
    expect(teslaIssuer(undefined)).toBe("https://auth.tesla.com/oauth2/v3");
  });
});

describe("api host mapping", () => {
  it("maps China issuers to the China cloud", () => {
    expect(apiHostFromIssuer("https://auth.tesla.cn/oauth2/v3")).toBe("https://owner-api.vn.cloud.tesla.cn");
  });

  it("defaults to the global Owner API", () => {
    expect(apiHostFromIssuer("https://auth.tesla.com/oauth2/v3")).toBe("https://owner-api.teslamotors.com");
  });
});
