import { describe, expect, it } from "bun:test";
import { RETURN_AFTER_MS, createReturnTracker } from "./refreshOnReturn";

/** A return refreshes the page only after a real absence, not a glance away. */

function tracker(start = 1_700_000_000_000) {
  let t = start;
  const tr = createReturnTracker(() => t);
  return { tr, advance: (ms: number) => (t += ms) };
}

describe("createReturnTracker", () => {
  it("does not refresh a tab that was never hidden", () => {
    const { tr, advance } = tracker();
    advance(RETURN_AFTER_MS * 10);
    expect(tr.cameBack()).toBe(false);
  });

  it("does not refresh after a short switch away", () => {
    const { tr, advance } = tracker();
    tr.note(true);
    advance(RETURN_AFTER_MS - 1);
    tr.note(false);
    expect(tr.cameBack()).toBe(false);
  });

  it("refreshes after a long absence", () => {
    const { tr, advance } = tracker();
    tr.note(true);
    advance(RETURN_AFTER_MS);
    tr.note(false);
    expect(tr.cameBack()).toBe(true);
  });

  it("measures from the latest hide", () => {
    const { tr, advance } = tracker();
    tr.note(true);
    advance(RETURN_AFTER_MS * 5);
    tr.note(false);
    tr.note(true);
    advance(1_000);
    tr.note(false);
    expect(tr.cameBack()).toBe(false);
  });
});
