import { afterEach, describe, expect, it, vi } from "vitest";
import { isTimeout, withDeadline } from "./deadline";

describe("withDeadline", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("leaves no timer pending once the work has answered", async () => {
    vi.useFakeTimers();
    await expect(withDeadline(10_000, async () => "answer")).resolves.toBe("answer");
    // The whole point: a pending timer keeps a Durable Object billed.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the timer when the work fails too", async () => {
    vi.useFakeTimers();
    await expect(
      withDeadline(10_000, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts work that outlives the deadline with a timeout", async () => {
    const pending = withDeadline(
      20,
      (signal) =>
        new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason));
        }),
    );
    const error = await pending.catch((e: unknown) => e);
    expect(isTimeout(error)).toBe(true);
  });
});

describe("isTimeout", () => {
  it("does not mistake other failures for a timeout", () => {
    expect(isTimeout(new Error("connection refused"))).toBe(false);
    expect(isTimeout("timed out")).toBe(false);
  });
});
