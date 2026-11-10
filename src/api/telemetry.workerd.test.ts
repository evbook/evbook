import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { SurveyStateDto } from "@shared/api-types";
import type { SurveyConfig } from "@shared/telemetry";
import { authed, getJson, login } from "../../test/http";
import { surveyState } from "./telemetry";

/**
 * The browser-facing telemetry endpoints. Nothing here opens a socket: events
 * only ever land in the outbox table, and the export lives in core/telemetry.
 */

function setLevel(level: string) {
  return env.DB.prepare("UPDATE settings SET telemetry_level = ? WHERE id = 1").bind(level).run();
}

async function queuedNames(): Promise<string[]> {
  const rows = await env.DB.prepare("SELECT event_name FROM telemetry_queue ORDER BY id").all<{ event_name: string }>();
  return rows.results.map((row) => row.event_name);
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM telemetry_queue").run();
  await env.DB.prepare("DELETE FROM survey_responses").run();
  await env.DB.prepare("UPDATE settings SET telemetry_level = 'off', telemetry_last_version = NULL WHERE id = 1").run();
});

describe("POST /api/v1/telemetry/error", () => {
  it("needs a session", async () => {
    const res = await SELF.fetch("https://x/api/v1/telemetry/error", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "boom" }),
    });
    expect(res.status).toBe(401);
  });

  it("answers 204 but records nothing while telemetry is off", async () => {
    const cookie = await login();
    const res = await authed(cookie, "/api/v1/telemetry/error", {
      method: "POST",
      body: JSON.stringify({ message: "boom" }),
    });
    expect(res.status).toBe(204);
    expect(await queuedNames()).toEqual([]);
  });

  it("queues the crash at minimal", async () => {
    await setLevel("minimal");
    const cookie = await login();
    const res = await authed(cookie, "/api/v1/telemetry/error", {
      method: "POST",
      body: JSON.stringify({ message: "boom", stack: "at somewhere", context: "/drives" }),
    });
    expect(res.status).toBe(204);
    expect(await queuedNames()).toEqual(["error.client"]);
  });

  it("rejects a shapeless body", async () => {
    const cookie = await login();
    const res = await authed(cookie, "/api/v1/telemetry/error", { method: "POST", body: JSON.stringify({}) });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/v1/telemetry/feedback", () => {
  it("queues the message at minimal", async () => {
    await setLevel("minimal");
    const cookie = await login();
    const res = await authed(cookie, "/api/v1/telemetry/feedback", {
      method: "POST",
      body: JSON.stringify({ message: "the chart looked wrong", context: "error-toast" }),
    });
    expect(res.status).toBe(204);
    expect(await queuedNames()).toEqual(["user.feedback"]);
  });
});

/** Fixture surveys for the exported state machine — the shipped file stays out of it. */
function survey(overrides: Partial<SurveyConfig> = {}): SurveyConfig {
  return {
    id: "s1",
    minAppVersion: "0.1.0",
    sampleRate: 1,
    minDelayMinutes: 0,
    maxDelayMinutes: 0,
    title: "t",
    questions: [{ id: "q1", type: "text", label: "?" }],
    ...overrides,
  };
}

describe("surveyState", () => {
  it("offers nothing while telemetry is off", async () => {
    expect((await surveyState(env.DB, [survey()], "1.0.0", () => 0)).survey).toBeNull();
  });

  it("offers nothing to an instance older than the survey", async () => {
    await setLevel("minimal");
    expect((await surveyState(env.DB, [survey({ minAppVersion: "2.0.0" })], "1.0.0", () => 0)).survey).toBeNull();
  });

  it("rolls the sample once and never again", async () => {
    await setLevel("minimal");
    // Sampled out on the first ask; a luckier random later must not re-roll.
    expect((await surveyState(env.DB, [survey({ sampleRate: 0.5 })], "1.0.0", () => 0.9)).survey).toBeNull();
    expect((await surveyState(env.DB, [survey({ sampleRate: 0.5 })], "1.0.0", () => 0.1)).survey).toBeNull();
    const row = await env.DB.prepare("SELECT status FROM survey_responses WHERE survey_id = 's1'").first<{
      status: string;
    }>();
    expect(row?.status).toBe("sampled_out");
  });

  it("keeps offering a rolled-in survey until it is settled", async () => {
    await setLevel("minimal");
    expect((await surveyState(env.DB, [survey()], "1.0.0", () => 0)).survey?.id).toBe("s1");
    expect((await surveyState(env.DB, [survey()], "1.0.0", () => 0)).survey?.id).toBe("s1");
    await env.DB.prepare("UPDATE survey_responses SET status = 'answered' WHERE survey_id = 's1'").run();
    expect((await surveyState(env.DB, [survey()], "1.0.0", () => 0)).survey).toBeNull();
  });

  it("moves on to the next eligible survey past settled ones", async () => {
    await setLevel("minimal");
    const surveys = [survey({ id: "old" }), survey({ id: "new" })];
    await env.DB.prepare(
      "INSERT INTO survey_responses (survey_id, status, created_at, updated_at) VALUES ('old', 'dismissed', 1, 1)",
    ).run();
    expect((await surveyState(env.DB, surveys, "1.0.0", () => 0)).survey?.id).toBe("new");
  });
});

describe("GET /api/v1/telemetry/survey", () => {
  it("answers the DTO shape", async () => {
    await setLevel("minimal");
    const cookie = await login();
    // The shipped example survey rides with a version far in the future, so a
    // real instance — and this suite — is never offered it by accident.
    const state = await getJson<SurveyStateDto>(cookie, "/api/v1/telemetry/survey");
    expect(state).toEqual({ survey: null });
  });
});

describe("POST /api/v1/telemetry/survey", () => {
  it("refuses a survey that was never shipped", async () => {
    const cookie = await login();
    const res = await authed(cookie, "/api/v1/telemetry/survey", {
      method: "POST",
      body: JSON.stringify({ surveyId: "made-up", status: "dismissed" }),
    });
    expect(res.status).toBe(404);
  });

  it("stores the answers, queues the event, and holds the first outcome", async () => {
    await setLevel("minimal");
    const cookie = await login();
    const res = await authed(cookie, "/api/v1/telemetry/survey", {
      method: "POST",
      body: JSON.stringify({
        surveyId: "example-survey",
        status: "answered",
        // `bogus` answers a question the survey does not ask; it must be dropped.
        answers: { satisfaction: 4, comments: "solid", bogus: "x" },
      }),
    });
    expect(res.status).toBe(204);
    const row = await env.DB.prepare("SELECT status, answers FROM survey_responses WHERE survey_id = 'example-survey'")
      .first<{ status: string; answers: string }>();
    expect(row?.status).toBe("answered");
    expect(JSON.parse(row!.answers)).toEqual({ satisfaction: 4, comments: "solid" });
    expect(await queuedNames()).toEqual(["survey.response"]);

    // A second submit — two tabs, a retry — is not new data.
    const again = await authed(cookie, "/api/v1/telemetry/survey", {
      method: "POST",
      body: JSON.stringify({ surveyId: "example-survey", status: "dismissed" }),
    });
    expect(again.status).toBe(204);
    const after = await env.DB.prepare("SELECT status FROM survey_responses WHERE survey_id = 'example-survey'")
      .first<{ status: string }>();
    expect(after?.status).toBe("answered");
    expect(await queuedNames()).toEqual(["survey.response"]);
  });

  it("records a dismissal so the survey never comes back", async () => {
    await setLevel("minimal");
    const cookie = await login();
    const res = await authed(cookie, "/api/v1/telemetry/survey", {
      method: "POST",
      body: JSON.stringify({ surveyId: "example-survey", status: "dismissed" }),
    });
    expect(res.status).toBe(204);
    const row = await env.DB.prepare("SELECT status, answers FROM survey_responses WHERE survey_id = 'example-survey'")
      .first<{ status: string; answers: string | null }>();
    expect(row).toEqual({ status: "dismissed", answers: null });
  });
});

describe("settings", () => {
  it("round-trips the telemetry level and stamps the install on first opt-in", async () => {
    const cookie = await login();
    const res = await authed(cookie, "/api/v1/settings", {
      method: "PUT",
      body: JSON.stringify({ telemetryLevel: "minimal" }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { telemetryLevel: string }).telemetryLevel).toBe("minimal");
    // Opting in is the moment the installation may first be reported.
    expect(await queuedNames()).toEqual(["app.install"]);
    await env.DB.prepare(
      "UPDATE settings SET telemetry_level = 'off', telemetry_last_version = NULL WHERE id = 1",
    ).run();
  });

  it("rejects a level it does not know", async () => {
    const cookie = await login();
    const res = await authed(cookie, "/api/v1/settings", {
      method: "PUT",
      body: JSON.stringify({ telemetryLevel: "everything" }),
    });
    expect(res.status).toBe(400);
  });
});
