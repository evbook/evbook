import { describe, expect, it } from "vitest";
import { decryptString, encryptString, safeEqual, signSession, verifySession } from "./crypto";

describe("session cookies", () => {
  it("round-trips a valid session", async () => {
    const cookie = await signSession("secret", Date.now() + 60_000);
    expect(await verifySession("secret", cookie)).toBe(true);
  });

  it("rejects expired sessions", async () => {
    const cookie = await signSession("secret", Date.now() - 1);
    expect(await verifySession("secret", cookie)).toBe(false);
  });

  it("rejects tampered expiry", async () => {
    const cookie = await signSession("secret", Date.now() + 60_000);
    const tampered = `${Date.now() + 999_999_999}.${cookie.split(".")[1]}`;
    expect(await verifySession("secret", tampered)).toBe(false);
  });

  it("rejects a different key", async () => {
    const cookie = await signSession("secret", Date.now() + 60_000);
    expect(await verifySession("other", cookie)).toBe(false);
  });

  it("rejects garbage", async () => {
    expect(await verifySession("secret", undefined)).toBe(false);
    expect(await verifySession("secret", "")).toBe(false);
    expect(await verifySession("secret", "abc.def")).toBe(false);
  });
});

describe("token encryption", () => {
  it("round-trips", async () => {
    const ct = await encryptString("key", "hello tokens");
    expect(ct).not.toContain("hello");
    expect(await decryptString("key", ct)).toBe("hello tokens");
  });

  it("fails with the wrong key", async () => {
    const ct = await encryptString("key", "hello");
    await expect(decryptString("wrong", ct)).rejects.toThrow();
  });

  it("uses a fresh IV per encryption", async () => {
    const a = await encryptString("key", "same");
    const b = await encryptString("key", "same");
    expect(a).not.toBe(b);
  });
});

describe("safeEqual", () => {
  it("compares correctly", async () => {
    expect(await safeEqual("a", "a")).toBe(true);
    expect(await safeEqual("a", "b")).toBe(false);
    expect(await safeEqual("a", "ab")).toBe(false);
  });
});
