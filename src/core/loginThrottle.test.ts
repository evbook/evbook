import { describe, expect, it } from "bun:test";
import { clientKey, isLocalAddress, lockMs, retryAfterSeconds, waitMs } from "./loginThrottle";

const MINUTE = 60 * 1000;

describe("lockMs", () => {
  it("locks from the fifth failure, a minute doubling up to an hour", () => {
    expect(lockMs(4)).toBe(0);
    expect(lockMs(5)).toBe(MINUTE);
    expect(lockMs(6)).toBe(2 * MINUTE);
    expect(lockMs(10)).toBe(32 * MINUTE);
    expect(lockMs(11)).toBe(60 * MINUTE);
    expect(lockMs(40)).toBe(60 * MINUTE);
  });
});

describe("retryAfterSeconds", () => {
  it("rounds up to whole seconds", () => {
    expect(retryAfterSeconds(60_000)).toBe(60);
    expect(retryAfterSeconds(30_001)).toBe(31);
  });

  it("is at least a second, even for a lock that has run out", () => {
    expect(retryAfterSeconds(1)).toBe(1);
    expect(retryAfterSeconds(0)).toBe(1);
    expect(retryAfterSeconds(-5_000)).toBe(1);
  });
});

describe("waitMs", () => {
  it("waits from the fifth failure, a second doubling up to eight", () => {
    expect(waitMs(4)).toBe(0);
    expect(waitMs(5)).toBe(1000);
    expect(waitMs(7)).toBe(4000);
    expect(waitMs(8)).toBe(8000);
    expect(waitMs(40)).toBe(8000);
  });
});

describe("clientKey", () => {
  it("keeps an IPv4 address as it is", () => {
    expect(clientKey("203.0.113.7")).toBe("203.0.113.7");
    expect(clientKey(" 203.0.113.7 ")).toBe("203.0.113.7");
  });

  it("counts an IPv6 address by its /64, however it is written", () => {
    const key = clientKey("2001:db8:1:2::1");
    expect(key).toBe("2001:db8:1:2::/64");
    expect(clientKey("2001:0DB8:0001:0002:ffff:0:0:9")).toBe(key);
    expect(clientKey("[2001:db8:1:2::abcd]")).toBe(key);
    expect(clientKey("2001:db8:1:2::1%eth0")).toBe(key);
    expect(clientKey("2001:db8:1:3::1")).not.toBe(key);
  });

  it("reads an IPv4 address written as IPv6 as that IPv4 address", () => {
    expect(clientKey("::ffff:203.0.113.7")).toBe("203.0.113.7");
  });

  it("has no key for what is not an address", () => {
    for (const text of [
      null,
      undefined,
      "",
      "unknown",
      "203.0.113",
      "203.0.113.256",
      "1:2:3",
      "1::2::3",
      "g::1",
      "1.2.3.4::",
      "1.2.3.4:5:6:7:8:9:10",
    ]) {
      expect(clientKey(text), String(text)).toBeNull();
    }
  });

  it("has no key for an address many people share: a tunnel, a LAN, a carrier's NAT", () => {
    for (const text of [
      "127.0.0.1",
      "::1",
      "::",
      "::ffff:127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.10",
      "169.254.1.1",
      "100.64.0.1",
      "100.127.255.255",
      "0.0.0.0",
      "fd12:3456::1",
      "fe80::1%eth0",
    ]) {
      expect(clientKey(text), text).toBeNull();
      expect(isLocalAddress(text), text).toBe(true);
    }
    for (const text of ["172.15.0.1", "172.32.0.1", "100.63.0.1", "100.128.0.1", "2001:db8::1", "203.0.113.7"]) {
      expect(clientKey(text), text).not.toBeNull();
      expect(isLocalAddress(text), text).toBe(false);
    }
    expect(isLocalAddress("not an address")).toBe(false);
  });
});
