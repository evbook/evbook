import { describe, expect, it } from "bun:test";
import { retryAfterMs } from "./http";

describe("retryAfterMs", () => {
  it("reads seconds and HTTP dates, and nothing else", () => {
    expect(retryAfterMs("30")).toBe(30_000);
    expect(retryAfterMs(new Date(1_000_000 + 5_000).toUTCString(), 1_000_000)).toBe(5_000);
    expect(retryAfterMs(new Date(1_000_000 - 5_000).toUTCString(), 1_000_000)).toBe(0);
    expect(retryAfterMs(null)).toBeNull();
    expect(retryAfterMs("soon")).toBeNull();
  });
});
