import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { APP_VERSION } from "@shared/version";
import {
  MAX_ATTEMPTS,
  QUEUE_CAP,
  collectTelemetryStats,
  flushTelemetry,
  otlpLogsPayload,
  recordEvent,
  recordVersionMilestones,
  reportError,
  telemetryEndpoint,
  telemetryInstanceId,
} from "./telemetry";

/**
 * The outbox and its gates, against the real database. Flushes that must
 * "reach" a collector pass a stub fetch — nothing here opens a socket.
 */

interface QueueRow {
  event_name: string;
  severity: string;
  attributes: string;
  attempts: number;
}

async function queued(): Promise<QueueRow[]> {
  const rows = await env.DB.prepare(
    "SELECT event_name, severity, attributes, attempts FROM telemetry_queue ORDER BY id",
  ).all<QueueRow>();
  return rows.results;
}

function setLevel(level: string) {
  return env.DB.prepare("UPDATE settings SET telemetry_level = ? WHERE id = 1").bind(level).run();
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM telemetry_queue").run();
  await env.DB.prepare("DELETE FROM survey_responses").run();
  await env.DB.prepare(
    "UPDATE settings SET telemetry_level = 'off', telemetry_instance_id = NULL, " +
      "telemetry_last_version = NULL, telemetry_stats_at = NULL WHERE id = 1",
  ).run();
});

describe("recordEvent", () => {
  it("records nothing while telemetry is off", async () => {
    expect(await recordEvent(env.DB, "minimal", "app.update", {})).toBe(false);
    expect(await queued()).toHaveLength(0);
  });

  it("gates extended events behind the extended level", async () => {
    await setLevel("minimal");
    expect(await recordEvent(env.DB, "extended", "vehicle.stats", {})).toBe(false);
    expect(await recordEvent(env.DB, "minimal", "app.update", {})).toBe(true);
    await setLevel("extended");
    expect(await recordEvent(env.DB, "extended", "vehicle.stats", {})).toBe(true);
    expect((await queued()).map((row) => row.event_name)).toEqual(["app.update", "vehicle.stats"]);
  });

  it("treats an unknown stored level as off", async () => {
    // The column carries no CHECK (SQLite cannot add one), so a value the app
    // does not know must fall in the private direction.
    await setLevel("everything");
    expect(await recordEvent(env.DB, "minimal", "app.update", {})).toBe(false);
  });

  it("drops null and undefined attributes and keeps the rest typed", async () => {
    await setLevel("minimal");
    await recordEvent(env.DB, "minimal", "vehicle.stats", { odometerKm: 12345, model: "Model 3", missing: null });
    const [row] = await queued();
    expect(JSON.parse(row!.attributes)).toEqual({ odometerKm: 12345, model: "Model 3" });
  });

  it("caps the queue, dropping the oldest", async () => {
    await setLevel("minimal");
    const now = Date.now();
    // Seeded directly — QUEUE_CAP inserts through recordEvent would prune each time.
    for (let i = 0; i < QUEUE_CAP + 2; i++) {
      await env.DB.prepare("INSERT INTO telemetry_queue (event_name, severity, attributes, created_at) VALUES (?, 'info', '{}', ?)")
        .bind(`seed.${i}`, now)
        .run();
    }
    await recordEvent(env.DB, "minimal", "app.update", {});
    const rows = await queued();
    expect(rows).toHaveLength(QUEUE_CAP);
    expect(rows[0]!.event_name).toBe("seed.3");
    expect(rows[rows.length - 1]!.event_name).toBe("app.update");
  });
});

describe("version milestones", () => {
  it("does not even stamp while off, so a later opt-in still reports the install", async () => {
    await recordVersionMilestones(env.DB);
    const row = await env.DB.prepare("SELECT telemetry_last_version AS v FROM settings WHERE id = 1").first<{
      v: string | null;
    }>();
    expect(row?.v).toBeNull();
    expect(await queued()).toHaveLength(0);

    await setLevel("minimal");
    await recordVersionMilestones(env.DB);
    const [event] = await queued();
    expect(event?.event_name).toBe("app.install");
    expect(JSON.parse(event!.attributes)).toEqual({ version: APP_VERSION });
  });

  it("reports an update once, from the last reported version", async () => {
    await setLevel("minimal");
    await env.DB.prepare("UPDATE settings SET telemetry_last_version = '0.1.0' WHERE id = 1").run();
    await recordVersionMilestones(env.DB);
    await recordVersionMilestones(env.DB); // second run: same version, no event
    const rows = await queued();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.event_name).toBe("app.update");
    expect(JSON.parse(rows[0]!.attributes)).toEqual({ fromVersion: "0.1.0", toVersion: APP_VERSION });
  });
});

describe("reportError", () => {
  it("truncates and marks severity", async () => {
    await setLevel("minimal");
    await reportError(env.DB, "client", { message: "x".repeat(600), stack: "s".repeat(5000), context: "render" });
    const [row] = await queued();
    expect(row!.event_name).toBe("error.client");
    expect(row!.severity).toBe("error");
    const attrs = JSON.parse(row!.attributes) as { message: string; stack: string };
    expect(attrs.message).toHaveLength(500);
    expect(attrs.stack).toHaveLength(4000);
  });
});

describe("collectTelemetryStats", () => {
  it("requires the extended level", async () => {
    await setLevel("minimal");
    await collectTelemetryStats(env.DB);
    expect(await queued()).toHaveLength(0);
  });

  it("snapshots at most once a day, stamping before it collects", async () => {
    await setLevel("extended");
    const now = Date.now();
    await collectTelemetryStats(env.DB, now);
    const first = await queued();
    expect(first.map((row) => row.event_name)).toContain("instance.stats");
    await collectTelemetryStats(env.DB, now + 60_000);
    expect(await queued()).toHaveLength(first.length);
    await collectTelemetryStats(env.DB, now + 25 * 60 * 60 * 1000);
    expect((await queued()).length).toBeGreaterThan(first.length);
  });

  it("reports each car without its VIN", async () => {
    await setLevel("extended");
    const now = Date.now();
    await env.DB.prepare("DELETE FROM cars").run();
    await env.DB.prepare(
      "INSERT INTO cars (id, vin, name, inserted_at, updated_at) VALUES (7, '5YJ3E1EB7MF016329', 'Bro', ?, ?)",
    )
      .bind(now, now)
      .run();
    await env.DB.prepare(
      "INSERT INTO positions (car_id, date_at, latitude, longitude, odometer) VALUES (7, ?, 1, 1, 42123.6)",
    )
      .bind(now)
      .run();
    await collectTelemetryStats(env.DB, now);
    const vehicle = (await queued()).find((row) => row.event_name === "vehicle.stats");
    const attrs = JSON.parse(vehicle!.attributes) as Record<string, unknown>;
    expect(attrs.car).toBe(7);
    expect(attrs.model).toBe("Model 3");
    expect(attrs.odometerKm).toBe(42124);
    expect(JSON.stringify(attrs)).not.toContain("5YJ3E1EB7MF016329");
    await env.DB.prepare("DELETE FROM positions").run();
    await env.DB.prepare("DELETE FROM cars").run();
  });
});

describe("flushTelemetry", () => {
  const config = { TELEMETRY_ENDPOINT: "https://collector.example/otlp/" };

  it("defaults to the project's collector", () => {
    expect(telemetryEndpoint({ TELEMETRY_ENDPOINT: "" })).toBe("https://telemetry.evbook.app");
  });

  it("does nothing when the endpoint is off", async () => {
    await setLevel("minimal");
    await recordEvent(env.DB, "minimal", "app.update", {});
    let called = 0;
    await flushTelemetry(env.DB, { TELEMETRY_ENDPOINT: "off" }, { fetchFn: (() => {
      called++;
      return Promise.resolve(new Response(null, { status: 200 }));
    }) as typeof fetch });
    expect(called).toBe(0);
    expect(await queued()).toHaveLength(1);
  });

  it("strips trailing slashes from the endpoint", () => {
    expect(telemetryEndpoint(config)).toBe("https://collector.example/otlp");
  });

  it("posts an OTLP logs envelope and deletes the batch on success", async () => {
    await setLevel("minimal");
    await recordEvent(env.DB, "minimal", "app.update", { fromVersion: "0.1.0" });
    const calls: { url: string; body: string }[] = [];
    await flushTelemetry(env.DB, config, {
      fetchFn: ((url: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(url), body: String(init?.body) });
        return Promise.resolve(new Response(null, { status: 200 }));
      }) as typeof fetch,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://collector.example/otlp/v1/logs");
    const payload = JSON.parse(calls[0]!.body) as {
      resourceLogs: { resource: { attributes: { key: string; value: { stringValue?: string } }[] }; scopeLogs: { logRecords: unknown[] }[] }[];
    };
    const resource = payload.resourceLogs[0]!.resource.attributes;
    expect(resource.find((a) => a.key === "service.name")?.value.stringValue).toBe("evbook");
    expect(resource.find((a) => a.key === "service.instance.id")?.value.stringValue).toMatch(/[0-9a-f-]{36}/);
    expect(payload.resourceLogs[0]!.scopeLogs[0]!.logRecords).toHaveLength(1);
    expect(await queued()).toHaveLength(0);
  });

  it("keeps the batch and counts the attempt when the collector fails, dropping poison rows", async () => {
    await setLevel("minimal");
    await recordEvent(env.DB, "minimal", "app.update", {});
    const failing = (() => Promise.resolve(new Response(null, { status: 503 }))) as typeof fetch;
    await flushTelemetry(env.DB, config, { fetchFn: failing });
    expect((await queued())[0]!.attempts).toBe(1);
    await env.DB.prepare("UPDATE telemetry_queue SET attempts = ?").bind(MAX_ATTEMPTS).run();
    await flushTelemetry(env.DB, config, { fetchFn: failing });
    expect(await queued()).toHaveLength(0);
  });

  it("survives a fetch that throws", async () => {
    await setLevel("minimal");
    await recordEvent(env.DB, "minimal", "app.update", {});
    await flushTelemetry(env.DB, config, { fetchFn: (() => Promise.reject(new Error("offline"))) as typeof fetch });
    expect((await queued())[0]!.attempts).toBe(1);
  });
});

describe("instance id", () => {
  it("mints once and keeps it", async () => {
    const first = await telemetryInstanceId(env.DB);
    expect(first).toMatch(/[0-9a-f-]{36}/);
    expect(await telemetryInstanceId(env.DB)).toBe(first);
  });
});

describe("otlpLogsPayload", () => {
  it("maps attribute types the OTLP way", () => {
    const payload = otlpLogsPayload(
      [{ id: 1, event_name: "e", severity: "info", attributes: JSON.stringify({ i: 3, d: 1.5, b: true, s: "x" }), created_at: 1_700_000_000_000 }],
      "instance",
    ) as {
      resourceLogs: { scopeLogs: { logRecords: { timeUnixNano: string; attributes: { key: string; value: Record<string, unknown> }[] }[] }[] }[];
    };
    const record = payload.resourceLogs[0]!.scopeLogs[0]!.logRecords[0]!;
    expect(record.timeUnixNano).toBe("1700000000000000000");
    const byKey = Object.fromEntries(record.attributes.map((a) => [a.key, a.value]));
    expect(byKey.i).toEqual({ intValue: "3" });
    expect(byKey.d).toEqual({ doubleValue: 1.5 });
    expect(byKey.b).toEqual({ boolValue: true });
    expect(byKey.s).toEqual({ stringValue: "x" });
    expect(byKey["event.name"]).toEqual({ stringValue: "e" });
  });
});
