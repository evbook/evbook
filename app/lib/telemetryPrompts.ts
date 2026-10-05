import { pickSurveyShowAt, type SurveyConfig } from "@shared/telemetry";

/**
 * The decisions behind the telemetry prompts (components/TelemetryPrompts.tsx),
 * kept pure so they can be tested without a window: what a caught error looks
 * like as a report, which errors are worth reporting at all, and when a survey
 * the server offered actually goes on screen.
 */

/** What the client tells the server about a crash — mirrored by the zod schema in src/api/telemetry.ts. */
export interface ErrorReport {
  message: string;
  stack?: string;
  /** Where it happened — a pathname, never user data. */
  context?: string;
}

/** One report from window's `error` event, whatever the thrown thing was. */
export function describeThrown(thrown: unknown, fallback: string, context: string): ErrorReport {
  if (thrown instanceof Error) {
    return { message: thrown.message || fallback, stack: thrown.stack, context };
  }
  const message = typeof thrown === "string" && thrown ? thrown : fallback;
  return { message, context };
}

/**
 * At most `max` reports a session, each distinct message once. A render loop
 * throwing sixty times a second is one fact, not sixty — and a session that
 * has already reported a handful of crashes has said everything useful.
 */
export function createErrorGate(max = 5): (message: string) => boolean {
  const seen = new Set<string>();
  return (message) => {
    if (seen.size >= max || seen.has(message)) return false;
    seen.add(message);
    return true;
  };
}

const SHOW_AT_KEY = "evbook.survey-show-at";

/** Only the two methods this needs, so a spec can pass a plain object. */
export type ShowAtStore = Pick<Storage, "getItem" | "setItem">;

/**
 * When to put an offered survey on screen, decided once per browser: the first
 * load that learns of the survey draws a moment from its delay window and
 * writes it down, and every later load honours that draw. A store that cannot
 * be read or written (private window) falls back to drawing each load — the
 * survey shows a little late, never twice, because answering is recorded
 * server-side.
 */
export function surveyShowAt(
  store: ShowAtStore,
  survey: Pick<SurveyConfig, "id" | "minDelayMinutes" | "maxDelayMinutes">,
  now: number,
  random: number,
): number {
  let stored: Record<string, unknown> = {};
  try {
    const raw = store.getItem(SHOW_AT_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (typeof parsed === "object" && parsed !== null) stored = parsed as Record<string, unknown>;
  } catch {
    // Unreadable is treated as empty.
  }
  const existing = stored[survey.id];
  if (typeof existing === "number") return existing;
  const showAt = pickSurveyShowAt(survey, now, random);
  try {
    store.setItem(SHOW_AT_KEY, JSON.stringify({ ...stored, [survey.id]: showAt }));
  } catch {
    // Storage refused; the draw simply happens again next load.
  }
  return showAt;
}
