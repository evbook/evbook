import { describe, expect, it } from "bun:test";
import { num, obj, reading, str, time } from "./reading";

describe("reading helpers", () => {
  it("keeps unknown unknown: no zero, no empty string, no coercion", () => {
    expect(reading(null, 1, 2)).toBeNull();
    expect(reading(0, 1, 2)).toEqual({ v: 0, at: 1, seen: 2 });
    expect(num("12")).toBeNull();
    expect(num(Number.NaN)).toBeNull();
    expect(num(0)).toBe(0);
    expect(str("")).toBeNull();
    expect(obj([])).toBeNull();
    expect(obj({ a: 1 })).toEqual({ a: 1 });
  });

  it("reads a time with any offset, and nothing that is not one", () => {
    expect(time("2026-10-02T13:51:37Z")).toBe(Date.UTC(2026, 9, 2, 13, 51, 37));
    expect(time("2026-10-02T22:51:37+09:00")).toBe(Date.UTC(2026, 9, 2, 13, 51, 37));
    expect(time("invalid")).toBeNull();
    expect(time(1_700_000_000_000)).toBeNull();
  });
});
