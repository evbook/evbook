import { describe, expect, it } from "bun:test";
import { apiHostFromIssuer, issuerFromAccessToken } from "./jwt";

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
});

describe("api host mapping", () => {
  it("maps China issuers to the China cloud", () => {
    expect(apiHostFromIssuer("https://auth.tesla.cn/oauth2/v3")).toBe("https://owner-api.vn.cloud.tesla.cn");
  });

  it("defaults to the global Owner API", () => {
    expect(apiHostFromIssuer("https://auth.tesla.com/oauth2/v3")).toBe("https://owner-api.teslamotors.com");
  });
});
