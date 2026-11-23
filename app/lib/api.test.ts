import { describe, expect, it } from "bun:test";
import { retryAfterHeader } from "./api";

describe("retryAfterHeader", () => {
  it("reads whole seconds", () => {
    expect(retryAfterHeader("60")).toBe(60);
    expect(retryAfterHeader("1")).toBe(1);
  });

  it("is undefined for a missing, empty, unparsable or non-positive header", () => {
    expect(retryAfterHeader(null)).toBeUndefined();
    expect(retryAfterHeader("")).toBeUndefined();
    expect(retryAfterHeader("soon")).toBeUndefined();
    expect(retryAfterHeader("0")).toBeUndefined();
    expect(retryAfterHeader("-3")).toBeUndefined();
  });
});
