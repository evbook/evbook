import { describe, expect, it } from "bun:test";
import {
  TELEMETRY_LEVELS,
  eligibleSurveys,
  isTelemetryLevel,
  pickSurveyShowAt,
  sampledIn,
  telemetryAllows,
  type SurveyConfig,
} from "./telemetry";
import surveysJson from "./surveys.json";

describe("telemetry levels", () => {
  it("orders off < minimal < extended", () => {
    expect(telemetryAllows("off", "minimal")).toBe(false);
    expect(telemetryAllows("off", "extended")).toBe(false);
    expect(telemetryAllows("minimal", "minimal")).toBe(true);
    expect(telemetryAllows("minimal", "extended")).toBe(false);
    expect(telemetryAllows("extended", "minimal")).toBe(true);
    expect(telemetryAllows("extended", "extended")).toBe(true);
  });

  it("recognises only the three level names", () => {
    for (const level of TELEMETRY_LEVELS) expect(isTelemetryLevel(level)).toBe(true);
    expect(isTelemetryLevel("all")).toBe(false);
    expect(isTelemetryLevel("")).toBe(false);
    expect(isTelemetryLevel(null)).toBe(false);
  });
});

function survey(overrides: Partial<SurveyConfig> = {}): SurveyConfig {
  return {
    id: "s1",
    minAppVersion: "0.4.0",
    sampleRate: 0.5,
    minDelayMinutes: 10,
    maxDelayMinutes: 70,
    title: "t",
    questions: [],
    ...overrides,
  };
}

describe("survey eligibility", () => {
  it("keeps surveys the running version is new enough for", () => {
    const surveys = [survey({ id: "old", minAppVersion: "0.3.0" }), survey({ id: "new", minAppVersion: "0.5.0" })];
    expect(eligibleSurveys(surveys, "0.4.0").map((s) => s.id)).toEqual(["old"]);
    expect(eligibleSurveys(surveys, "0.5.0").map((s) => s.id)).toEqual(["old", "new"]);
    // The version the survey rides with qualifies — that is the update it is about.
    expect(eligibleSurveys([survey()], "0.4.0")).toHaveLength(1);
  });

  it("samples strictly below the rate", () => {
    expect(sampledIn(survey({ sampleRate: 0.5 }), 0.49)).toBe(true);
    expect(sampledIn(survey({ sampleRate: 0.5 }), 0.5)).toBe(false);
    // Rate 0 asks nobody, rate 1 asks everybody — Math.random never returns 1.
    expect(sampledIn(survey({ sampleRate: 0 }), 0)).toBe(false);
    expect(sampledIn(survey({ sampleRate: 1 }), 0.999)).toBe(true);
  });

  it("draws the show time from inside the delay window", () => {
    const now = 1_000_000;
    expect(pickSurveyShowAt(survey(), now, 0)).toBe(now + 10 * 60_000);
    expect(pickSurveyShowAt(survey(), now, 0.5)).toBe(now + 40 * 60_000);
    // A window written backwards collapses to its minimum rather than going negative.
    expect(pickSurveyShowAt(survey({ minDelayMinutes: 60, maxDelayMinutes: 10 }), now, 0.9)).toBe(now + 60 * 60_000);
  });
});

describe("surveys.json", () => {
  it("carries well-formed surveys with unique ids", () => {
    const surveys = surveysJson.surveys as SurveyConfig[];
    const ids = new Set<string>();
    for (const s of surveys) {
      expect(s.id.length, s.id).toBeGreaterThan(0);
      expect(ids.has(s.id), `duplicate id ${s.id}`).toBe(false);
      ids.add(s.id);
      expect(s.sampleRate).toBeGreaterThanOrEqual(0);
      expect(s.sampleRate).toBeLessThanOrEqual(1);
      expect(s.questions.length).toBeGreaterThan(0);
      for (const q of s.questions) {
        expect(["scale", "select", "text"]).toContain(q.type);
        if (q.type === "select") expect(q.options?.length ?? 0).toBeGreaterThan(0);
        if (q.type === "scale") {
          expect(q.min).toBeTypeOf("number");
          expect(q.max).toBeTypeOf("number");
          expect(q.max!).toBeGreaterThan(q.min!);
        }
      }
    }
  });
});
