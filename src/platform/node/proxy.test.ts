import { describe, expect, it } from "bun:test";
import { forwardedClient } from "./proxy";

const request = (forwardedFor?: string) =>
  new Request("http://evbook.internal/api/v1/auth/login", {
    headers: forwardedFor === undefined ? {} : { "x-forwarded-for": forwardedFor },
  });

describe("forwardedClient", () => {
  it("reads nothing unless the proxy is trusted", () => {
    expect(forwardedClient(request("203.0.113.7"), false, "127.0.0.1")).toBeNull();
  });

  it("takes the entry the proxy appended, not the ones the client sent", () => {
    expect(forwardedClient(request("198.51.100.1, 10.0.0.9,203.0.113.7"), true, "127.0.0.1")).toBe("203.0.113.7");
    expect(forwardedClient(request("203.0.113.7"), true, "::1")).toBe("203.0.113.7");
  });

  it("believes the header only from a proxy on a local address", () => {
    for (const peer of ["127.0.0.1", "::ffff:127.0.0.1", "::1", "172.17.0.1", "10.0.0.2", "192.168.1.5", "fd00::5"]) {
      expect(forwardedClient(request("203.0.113.7"), true, peer), peer).toBe("203.0.113.7");
    }
    // A published port reached from the internet: the caller wrote the header.
    for (const peer of ["198.51.100.20", "2001:db8::20", undefined]) {
      expect(forwardedClient(request("203.0.113.7"), true, peer), String(peer)).toBeNull();
    }
  });

  it("has no address when the header is missing or empty", () => {
    expect(forwardedClient(request(), true, "127.0.0.1")).toBeNull();
    expect(forwardedClient(request(""), true, "127.0.0.1")).toBeNull();
    expect(forwardedClient(request("198.51.100.1, "), true, "127.0.0.1")).toBeNull();
  });
});
