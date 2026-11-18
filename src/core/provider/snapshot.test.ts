import { describe, expect, it } from "bun:test";
import { fingerprint } from "./snapshot";

const VOLATILE = new Set(["timestamp", "requestId"]);

describe("fingerprint", () => {
  it("ignores the volatile keys and the key order, at any depth", async () => {
    const a = await fingerprint({ data: { value: 1, unit: "km", timestamp: "2026-01-01T00:00:00Z" } }, VOLATILE);
    const b = await fingerprint(
      { requestId: "z", data: { unit: "km", timestamp: "2026-02-01T00:00:00Z", value: 1 } },
      VOLATILE,
    );
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("tells a changed value apart, inside arrays too", async () => {
    const a = await fingerprint({ list: [{ value: 1, timestamp: "a" }] }, VOLATILE);
    const b = await fingerprint({ list: [{ value: 2, timestamp: "a" }] }, VOLATILE);
    expect(a).not.toBe(b);
  });

  it("keeps a key that is volatile only for another provider", async () => {
    const a = await fingerprint({ timestamp: 1 }, new Set());
    const b = await fingerprint({ timestamp: 2 }, new Set());
    expect(a).not.toBe(b);
  });
});
