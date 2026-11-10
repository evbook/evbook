import { compareVersions } from "./version";

/**
 * Telemetry: what an instance may report about itself, and the surveys that
 * ride along with updates. All of it is opt-in ('off' is the default), and all
 * of it leaves through one place — the instance's own outbox, exported by the
 * cron (src/core/telemetry.ts) — never from the browser, for the same reason
 * the update check works that way: nobody's home IP is handed to a third party
 * by opening the app.
 */

/**
 * Where events go: an OTLP/HTTP collector, `POST {endpoint}/v1/logs`. The
 * default is the project's own collector (telemetry.evbook.app, a Worker on
 * the project's Cloudflare account). Nothing is sent unless the
 * owner turns telemetry on; a deployment can point elsewhere (or at a local
 * collector) with the TELEMETRY_ENDPOINT var.
 */
export const DEFAULT_TELEMETRY_ENDPOINT = "https://telemetry.evbook.app";

/** In order of how much they share; every level includes the ones before it. */
export const TELEMETRY_LEVELS = ["off", "minimal", "extended"] as const;

export type TelemetryLevel = (typeof TELEMETRY_LEVELS)[number];

export function isTelemetryLevel(value: unknown): value is TelemetryLevel {
  return typeof value === "string" && (TELEMETRY_LEVELS as readonly string[]).includes(value);
}

/**
 * Whether a level covers an event that requires `required`. 'off' covers
 * nothing, including itself: there are no events that require 'off'.
 */
export function telemetryAllows(level: TelemetryLevel, required: "minimal" | "extended"): boolean {
  return TELEMETRY_LEVELS.indexOf(level) >= TELEMETRY_LEVELS.indexOf(required);
}

/** Flat key/values on an event; null and undefined entries are dropped, not sent. */
export type EventAttributes = Record<string, string | number | boolean | null | undefined>;

/**
 * A survey shipped with a release (shared/surveys.json). It becomes eligible
 * on any instance running `minAppVersion` or newer that has telemetry on, gets
 * one sampling roll per instance, and — sampled in — is shown once, at a
 * random moment inside the delay window, then never again whatever the answer.
 */
export interface SurveyQuestion {
  id: string;
  label: string;
  /** 'scale' renders min..max buttons, 'select' a dropdown, 'text' a free box. */
  type: "scale" | "select" | "text";
  /** For 'select'. */
  options?: string[];
  /** For 'scale'. */
  min?: number;
  max?: number;
  minLabel?: string;
  maxLabel?: string;
}

export interface SurveyConfig {
  id: string;
  /** The release the survey rides with; older instances never see it. */
  minAppVersion: string;
  /** 0..1 — the share of instances asked at all. The roll happens once. */
  sampleRate: number;
  /** The random display delay is drawn from this window, in minutes. */
  minDelayMinutes: number;
  maxDelayMinutes: number;
  title: string;
  description?: string;
  questions: SurveyQuestion[];
}

/** Surveys an instance running `appVersion` is new enough for, file order kept. */
export function eligibleSurveys(surveys: SurveyConfig[], appVersion: string): SurveyConfig[] {
  return surveys.filter((survey) => compareVersions(appVersion, survey.minAppVersion) >= 0);
}

/** One sampling roll: `random` is Math.random-shaped, in [0, 1). */
export function sampledIn(survey: Pick<SurveyConfig, "sampleRate">, random: number): boolean {
  return random < survey.sampleRate;
}

/**
 * When to actually put the survey on screen, drawn once per instance from the
 * survey's window — so a release does not make every installation pop the same
 * dialog at the same minute, and the ask lands mid-use rather than on the
 * first anxious load after an update.
 */
export function pickSurveyShowAt(
  survey: Pick<SurveyConfig, "minDelayMinutes" | "maxDelayMinutes">,
  now: number,
  random: number,
): number {
  const min = Math.max(0, survey.minDelayMinutes);
  const max = Math.max(min, survey.maxDelayMinutes);
  return now + (min + (max - min) * random) * 60_000;
}
