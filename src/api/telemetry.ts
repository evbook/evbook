import { Hono } from "hono";
import { z } from "zod";
import type { SurveyStateDto } from "@shared/api-types";
import { eligibleSurveys, sampledIn, type SurveyConfig } from "@shared/telemetry";
import { APP_VERSION } from "@shared/version";
import surveysJson from "@shared/surveys.json";
import type { AppEnv } from "../platform/env";
import type { SqlDatabase } from "../platform/ports";
import { readTelemetryLevel, recordEvent, reportError } from "../core/telemetry";

/**
 * The browser's side of telemetry: crash reports, the feedback box behind the
 * error toast, and the post-update surveys. Everything lands in the outbox
 * (core/telemetry.ts) — the browser never talks to the collector, and every
 * write here re-checks the owner's level itself, so a stale client cannot
 * report anything the setting no longer covers.
 */

const SHIPPED_SURVEYS = surveysJson.surveys as SurveyConfig[];

const ErrorReport = z.object({
  message: z.string().min(1).max(2000),
  stack: z.string().max(10_000).optional(),
  /** Where it happened — a pathname or a lifecycle note, never user data. */
  context: z.string().max(500).optional(),
});

const Feedback = z.object({
  message: z.string().min(1).max(4000),
  context: z.string().max(500).optional(),
});

const SurveyPost = z.object({
  surveyId: z.string().min(1).max(100),
  status: z.enum(["answered", "dismissed"]),
  answers: z.record(z.string().max(100), z.union([z.string().max(2000), z.number()])).optional(),
});

/**
 * The survey to offer, or null. The sampling roll happens here, exactly once
 * per survey per instance: the decision is written down before it is acted on,
 * so reloading the page can never re-roll the dice. Exported with its inputs
 * as parameters so the spec can drive it; the route binds the shipped file,
 * the running version and Math.random.
 */
export async function surveyState(
  db: SqlDatabase,
  surveys: SurveyConfig[],
  appVersion: string,
  random: () => number,
  now = Date.now(),
): Promise<SurveyStateDto> {
  const level = await readTelemetryLevel(db);
  if (level === "off") return { survey: null };
  const eligible = eligibleSurveys(surveys, appVersion);
  if (eligible.length === 0) return { survey: null };

  const rows = await db.prepare("SELECT survey_id, status FROM survey_responses").all<{
    survey_id: string;
    status: string;
  }>();
  const settled = new Map(rows.results.map((row) => [row.survey_id, row.status]));

  for (const survey of eligible) {
    const status = settled.get(survey.id);
    if (status === "offered") return { survey };
    if (status) continue; // answered, dismissed or sampled out — never asked again
    const rolled = sampledIn(survey, random()) ? "offered" : "sampled_out";
    // OR IGNORE: two tabs rolling at once keep the first roll, matching the
    // read-back a real race would see on its next request.
    await db
      .prepare("INSERT OR IGNORE INTO survey_responses (survey_id, status, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .bind(survey.id, rolled, now, now)
      .run();
    if (rolled === "offered") return { survey };
  }
  return { survey: null };
}

export const telemetryRoutes = new Hono<{ Bindings: AppEnv }>()
  /**
   * A crash the client caught. Answers 204 whatever the level says: whether
   * anything was recorded is the owner's setting speaking, not an error, and
   * not something an error handler should have to branch on.
   */
  .post("/telemetry/error", async (c) => {
    const parsed = ErrorReport.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_request", message: parsed.error.message }, 400);
    await reportError(c.env.DB, "client", parsed.data);
    return c.body(null, 204);
  })

  /** What the person typed into the box behind the error toast. */
  .post("/telemetry/feedback", async (c) => {
    const parsed = Feedback.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_request", message: parsed.error.message }, 400);
    await recordEvent(c.env.DB, "minimal", "user.feedback", {
      message: parsed.data.message,
      context: parsed.data.context,
      version: APP_VERSION,
    });
    return c.body(null, 204);
  })

  .get("/telemetry/survey", async (c) => c.json(await surveyState(c.env.DB, SHIPPED_SURVEYS, APP_VERSION, Math.random)))

  /**
   * The survey's outcome. Stored first — the row is what "never prompted
   * again" means — and only then queued for export. A survey already settled
   * stays as it was: a second submit (two tabs, a retry) is not new data.
   */
  .post("/telemetry/survey", async (c) => {
    const parsed = SurveyPost.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_request", message: parsed.error.message }, 400);
    const { surveyId, status } = parsed.data;
    const survey = SHIPPED_SURVEYS.find((s) => s.id === surveyId);
    if (!survey) return c.json({ error: "unknown_survey" }, 404);

    // Only answers to questions the survey actually asks are kept.
    const questionIds = new Set(survey.questions.map((q) => q.id));
    const answers =
      status === "answered"
        ? Object.fromEntries(Object.entries(parsed.data.answers ?? {}).filter(([id]) => questionIds.has(id)))
        : null;

    const existing = await c.env.DB.prepare("SELECT status FROM survey_responses WHERE survey_id = ?")
      .bind(surveyId)
      .first<{ status: string }>();
    if (existing && existing.status !== "offered") return c.body(null, 204);

    const now = Date.now();
    await c.env.DB.prepare(
      "INSERT INTO survey_responses (survey_id, status, answers, created_at, updated_at) VALUES (?, ?, ?, ?, ?) " +
        "ON CONFLICT(survey_id) DO UPDATE SET status = excluded.status, answers = excluded.answers, updated_at = excluded.updated_at",
    )
      .bind(surveyId, status, answers ? JSON.stringify(answers) : null, now, now)
      .run();

    const attributes: Record<string, string | number> = { surveyId, status, version: APP_VERSION };
    for (const [id, value] of Object.entries(answers ?? {})) attributes[`answer.${id}`] = value;
    await recordEvent(c.env.DB, "minimal", "survey.response", attributes, { now });
    return c.body(null, 204);
  });
