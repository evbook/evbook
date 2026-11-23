import { describe, expect, it } from "bun:test";
import { forwardedClient } from "./proxy";

const request = (forwardedFor?: string) =>
  new Request("http://evbook.internal/api/v1/auth/login", {
    headers: forwardedFor === undefined ? {} : { "x-forwarded-for": forwardedFor },
  });

describe("forwardedClient", () => {
  it("reads nothing unless the proxy is trusted", () => {
    expect(forwardedClient(request("203.0.113.7"), false)).toBeNull();
  });

  it("takes the entry the proxy appended, not the ones the client sent", () => {
    expect(forwardedClient(request("198.51.100.1, 10.0.0.9,203.0.113.7"), true)).toBe("203.0.113.7");
    expect(forwardedClient(request("203.0.113.7"), true)).toBe("203.0.113.7");
  });

  it("has no address when the header is missing or empty", () => {
    expect(forwardedClient(request(), true)).toBeNull();
    expect(forwardedClient(request(""), true)).toBeNull();
    expect(forwardedClient(request("198.51.100.1, "), true)).toBeNull();
  });
});
