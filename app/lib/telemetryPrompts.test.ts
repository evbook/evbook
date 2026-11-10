import { describe, expect, it } from "bun:test";
import { createErrorGate, describeThrown, surveyShowAt, type ShowAtStore } from "./telemetryPrompts";

describe("describeThrown", () => {
  it("keeps an Error's message and stack", () => {
    const error = new Error("boom");
    expect(describeThrown(error, "fallback", "/drives")).toEqual({
      message: "boom",
      stack: error.stack,
      context: "/drives",
    });
  });

  it("reports a thrown string as itself and anything else as the fallback", () => {
    expect(describeThrown("just text", "fallback", "/")).toEqual({ message: "just text", context: "/" });
    expect(describeThrown({ odd: true }, "Script error", "/")).toEqual({ message: "Script error", context: "/" });
    expect(describeThrown(new Error(""), "Unhandled rejection", "/").message).toBe("Unhandled rejection");
  });
});

describe("createErrorGate", () => {
  it("passes a message once and caps the session", () => {
    const gate = createErrorGate(2);
    expect(gate("a")).toBe(true);
    expect(gate("a")).toBe(false); // a render loop is one fact, not sixty
    expect(gate("b")).toBe(true);
    expect(gate("c")).toBe(false); // the session has said everything useful
  });
});

function memoryStore(initial: Record<string, string> = {}): ShowAtStore & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => {
      data[key] = value;
    },
  };
}

const SURVEY = { id: "s1", minDelayMinutes: 10, maxDelayMinutes: 70 };

describe("surveyShowAt", () => {
  it("draws inside the window and remembers the draw", () => {
    const store = memoryStore();
    const first = surveyShowAt(store, SURVEY, 1_000_000, 0.5);
    expect(first).toBe(1_000_000 + 40 * 60_000);
    // A later load with different randomness honours the first draw.
    expect(surveyShowAt(store, SURVEY, 2_000_000, 0.9)).toBe(first);
  });

  it("keeps other surveys' draws when adding one", () => {
    const store = memoryStore();
    surveyShowAt(store, SURVEY, 0, 0);
    surveyShowAt(store, { ...SURVEY, id: "s2" }, 0, 1);
    const stored = JSON.parse(store.data["evbook.survey-show-at"]!) as Record<string, number>;
    expect(Object.keys(stored).sort()).toEqual(["s1", "s2"]);
  });

  it("survives a store that throws and a value that is not JSON", () => {
    const broken: ShowAtStore = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(surveyShowAt(broken, SURVEY, 0, 0)).toBe(10 * 60_000);
    const junk = memoryStore({ "evbook.survey-show-at": "not json" });
    expect(surveyShowAt(junk, SURVEY, 0, 0)).toBe(10 * 60_000);
  });
});
