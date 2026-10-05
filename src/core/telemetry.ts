import type { EventAttributes } from "@shared/telemetry";
import { withDeadline } from "./deadline";
import {
  DEFAULT_TELEMETRY_ENDPOINT,
  isTelemetryLevel,
  telemetryAllows,
  type TelemetryLevel,
} from "@shared/telemetry";
import { APP_VERSION } from "@shared/version";
import { decodeVin } from "@shared/vin";
import type { AppConfig } from "../platform/env";
import type { SqlDatabase } from "../platform/ports";
import { COUNTED_TABLES } from "../db/queries/dataHealth";
import { batteryHealth } from "../db/queries/stats";

/**
 * Opt-in telemetry, exported the way the update check asks GitHub: by the
 * instance, from the cron, never by the browser. Events are written to an
 * outbox table when they happen and flushed to the OTLP collector in batches,
 * so a collector that is down — or not configured yet — loses nothing and no
 * page load ever waits on it.
 *
 * What may be recorded at all is the owner's `telemetry_level` setting, checked
 * at the moment of recording: 'off' (default) records nothing, 'minimal' the
 * install/update milestones and critical errors, 'extended' adds anonymous
 * vehicle and database statistics. The only identity attached is a random UUID
 * minted here — never a VIN, a coordinate, a name, or an address.
 */

/** The OTLP/HTTP collector; empty = telemetry cannot leave the instance. */
export type TelemetryConfig = Pick<AppConfig, "TELEMETRY_ENDPOINT">;

/** Outbox rows kept: old enough to survive a collector outage, small enough to cap a dead one. */
export const QUEUE_CAP = 500;

/** Rows are sent oldest-first in batches of this many per cron flush. */
const FLUSH_BATCH = 100;

/** A batch that fails this many flushes is dropped rather than retried forever. */
export const MAX_ATTEMPTS = 10;

/** How often the extended statistics snapshot is taken. */
const STATS_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Long enough for a slow collector, short enough not to sit inside the cron. */
const REQUEST_TIMEOUT_MS = 8_000;

export function telemetryEndpoint(config: TelemetryConfig): string {
  return (config.TELEMETRY_ENDPOINT || DEFAULT_TELEMETRY_ENDPOINT).replace(/\/+$/, "");
}

/** The owner's choice, falling back to 'off' — the safe direction for a privacy knob. */
export async function readTelemetryLevel(db: SqlDatabase): Promise<TelemetryLevel> {
  const row = await db.prepare("SELECT telemetry_level AS level FROM settings WHERE id = 1").first<{ level: string }>();
  return row && isTelemetryLevel(row.level) ? row.level : "off";
}

/**
 * The anonymous instance id, minted on first use. COALESCE keeps the first
 * write: two isolates racing here must not leave events under two identities.
 */
export async function telemetryInstanceId(db: SqlDatabase): Promise<string> {
  const read = () =>
    db.prepare("SELECT telemetry_instance_id AS id FROM settings WHERE id = 1").first<{ id: string | null }>();
  const row = await read();
  if (row?.id) return row.id;
  const minted = crypto.randomUUID();
  await db
    .prepare("UPDATE settings SET telemetry_instance_id = COALESCE(telemetry_instance_id, ?) WHERE id = 1")
    .bind(minted)
    .run();
  return (await read())?.id ?? minted;
}

/**
 * Queue one event, if the current level covers it. Null/undefined attributes
 * are dropped rather than sent as empty strings. Returns whether it was kept —
 * callers never treat false as an error, it is the owner's setting speaking.
 */
export async function recordEvent(
  db: SqlDatabase,
  required: "minimal" | "extended",
  name: string,
  attributes: EventAttributes = {},
  opts: { severity?: "info" | "error"; now?: number } = {},
): Promise<boolean> {
  const level = await readTelemetryLevel(db);
  if (!telemetryAllows(level, required)) return false;
  const kept = Object.fromEntries(Object.entries(attributes).filter(([, value]) => value !== null && value !== undefined));
  await db
    .prepare("INSERT INTO telemetry_queue (event_name, severity, attributes, created_at) VALUES (?, ?, ?, ?)")
    .bind(name, opts.severity ?? "info", JSON.stringify(kept), opts.now ?? Date.now())
    .run();
  // Capped on insert, oldest first: an endpoint that never answers must not
  // grow the table without bound, and the newest events are the ones worth
  // keeping when it comes back.
  await db
    .prepare("DELETE FROM telemetry_queue WHERE id NOT IN (SELECT id FROM telemetry_queue ORDER BY id DESC LIMIT ?)")
    .bind(QUEUE_CAP)
    .run();
  return true;
}

/**
 * Notice an install (no version ever reported) or an update (a different one)
 * and say so. The stamp only moves while telemetry is on: stamping while off
 * would swallow the install event of an owner who opts in after first boot —
 * their first enabled run is the moment "this installation exists" is allowed
 * to be said. An update that happened entirely while telemetry was off is
 * reported from the last version it was on for, which is the truthful span.
 */
export async function recordVersionMilestones(db: SqlDatabase, now = Date.now()): Promise<void> {
  const row = await db
    .prepare("SELECT telemetry_level AS level, telemetry_last_version AS last FROM settings WHERE id = 1")
    .first<{ level: string; last: string | null }>();
  const level = row && isTelemetryLevel(row.level) ? row.level : "off";
  if (!telemetryAllows(level, "minimal")) return;
  if (row?.last === APP_VERSION) return;
  await db.prepare("UPDATE settings SET telemetry_last_version = ? WHERE id = 1").bind(APP_VERSION).run();
  if (row?.last) {
    await recordEvent(db, "minimal", "app.update", { fromVersion: row.last, toVersion: APP_VERSION }, { now });
  } else {
    await recordEvent(db, "minimal", "app.install", { version: APP_VERSION }, { now });
  }
}

const MESSAGE_LIMIT = 500;
const STACK_LIMIT = 4_000;

/** A crash worth telling the project about — route handlers and the client reporter both land here. */
export async function reportError(
  db: SqlDatabase,
  source: "client" | "server",
  detail: { message: string; stack?: string; context?: string },
  now = Date.now(),
): Promise<boolean> {
  return recordEvent(
    db,
    "minimal",
    `error.${source}`,
    {
      message: detail.message.slice(0, MESSAGE_LIMIT),
      stack: detail.stack?.slice(0, STACK_LIMIT),
      context: detail.context?.slice(0, MESSAGE_LIMIT),
      version: APP_VERSION,
    },
    { severity: "error", now },
  );
}

/**
 * The daily 'extended' snapshot: one instance.stats event (row counts, car
 * count) and one vehicle.stats per car (model and year off the VIN — never the
 * VIN itself — odometer, pack capacity and degradation, firmware). The clock is
 * stamped before collecting, like the update check's: a snapshot that throws
 * must wait for tomorrow, not retry every ten minutes.
 */
export async function collectTelemetryStats(db: SqlDatabase, now = Date.now()): Promise<void> {
  const row = await db
    .prepare(
      "SELECT telemetry_level AS level, telemetry_stats_at AS stats_at, preferred_range AS range FROM settings WHERE id = 1",
    )
    .first<{ level: string; stats_at: number | null; range: string }>();
  const level = row && isTelemetryLevel(row.level) ? row.level : "off";
  if (!telemetryAllows(level, "extended")) return;
  if (row?.stats_at != null && now - row.stats_at < STATS_INTERVAL_MS) return;
  await db.prepare("UPDATE settings SET telemetry_stats_at = ? WHERE id = 1").bind(now).run();

  const counts = await db
    .prepare(`SELECT ${COUNTED_TABLES.map((table) => `(SELECT COUNT(*) FROM ${table}) AS "${table}"`).join(", ")}`)
    .first<Record<string, number>>();
  const instance: EventAttributes = { version: APP_VERSION };
  for (const table of COUNTED_TABLES) instance[`rows.${table}`] = counts?.[table] ?? 0;
  await recordEvent(db, "extended", "instance.stats", instance, { now });

  const preferredRange = row?.range === "ideal" ? "ideal" : "rated";
  const cars = await db
    .prepare("SELECT id, vin, model FROM cars ORDER BY id")
    .all<{ id: number; vin: string; model: string | null }>();
  for (const car of cars.results) {
    const vin = decodeVin(car.vin);
    const health = await batteryHealth(db, { carId: car.id, preferredRange });
    const odometer = await db
      .prepare("SELECT odometer FROM positions WHERE car_id = ? AND odometer IS NOT NULL ORDER BY date_at DESC LIMIT 1")
      .bind(car.id)
      .first<{ odometer: number }>();
    const firmware = await db
      .prepare("SELECT version FROM updates WHERE car_id = ? ORDER BY start_date_at DESC LIMIT 1")
      .bind(car.id)
      .first<{ version: string | null }>();
    await recordEvent(
      db,
      "extended",
      "vehicle.stats",
      {
        // The local ordinal, so one instance's cars stay apart — meaningless anywhere else.
        car: car.id,
        model: car.model ?? vin.modelName,
        modelYear: vin.modelYear,
        odometerKm: odometer ? Math.round(odometer.odometer) : undefined,
        capacityKwh: health.currentCapacityKwh,
        degradationPercent: health.degradationPercent,
        degradationFromNewPercent: health.degradationFromNewPercent,
        firmware: firmware?.version,
      },
      { now },
    );
  }
}

interface QueueRow {
  id: number;
  event_name: string;
  severity: string;
  attributes: string;
  created_at: number;
}

type OtlpValue = { stringValue: string } | { boolValue: boolean } | { intValue: string } | { doubleValue: number };

function otlpValue(value: unknown): OtlpValue {
  if (typeof value === "boolean") return { boolValue: value };
  // OTLP/JSON carries 64-bit integers as strings.
  if (typeof value === "number") return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  return { stringValue: String(value) };
}

function otlpAttributes(record: Record<string, unknown>): { key: string; value: OtlpValue }[] {
  return Object.entries(record).map(([key, value]) => ({ key, value: otlpValue(value) }));
}

const SEVERITIES: Record<string, { severityNumber: number; severityText: string }> = {
  info: { severityNumber: 9, severityText: "INFO" },
  error: { severityNumber: 17, severityText: "ERROR" },
};

/** The OTLP/JSON `logs` envelope for one batch — exported so the spec can pin the shape. */
export function otlpLogsPayload(rows: QueueRow[], instanceId: string): unknown {
  return {
    resourceLogs: [
      {
        resource: {
          attributes: otlpAttributes({
            "service.name": "evbook",
            "service.version": APP_VERSION,
            "service.instance.id": instanceId,
          }),
        },
        scopeLogs: [
          {
            scope: { name: "evbook" },
            logRecords: rows.map((row) => {
              const severity = SEVERITIES[row.severity] ?? SEVERITIES.info!;
              let attributes: Record<string, unknown> = {};
              try {
                attributes = JSON.parse(row.attributes) as Record<string, unknown>;
              } catch {
                // A row that cannot be parsed still reports its name.
              }
              return {
                timeUnixNano: String(row.created_at) + "000000",
                ...severity,
                body: { stringValue: row.event_name },
                attributes: otlpAttributes({ "event.name": row.event_name, ...attributes }),
              };
            }),
          },
        ],
      },
    ],
  };
}

/**
 * Send the oldest batch to the collector and delete it on success. On failure
 * the batch stays put with its attempts counted, and rows that have failed too
 * often are dropped up front — a collector that is briefly down costs nothing,
 * one that rejects a poison row forever must not jam the queue behind it.
 * Network failures are swallowed like the update check's: telemetry is never
 * worth failing a cron run over.
 */
export async function flushTelemetry(
  db: SqlDatabase,
  config: TelemetryConfig,
  opts: { fetchFn?: typeof fetch } = {},
): Promise<void> {
  const endpoint = telemetryEndpoint(config);
  if (!endpoint) return;
  await db.prepare("DELETE FROM telemetry_queue WHERE attempts >= ?").bind(MAX_ATTEMPTS).run();
  const rows = await db
    .prepare("SELECT id, event_name, severity, attributes, created_at FROM telemetry_queue ORDER BY id LIMIT ?")
    .bind(FLUSH_BATCH)
    .all<QueueRow>();
  if (rows.results.length === 0) return;
  // The batch is the contiguous id prefix, so "these rows" is one comparison —
  // events queued while the request is in flight all sort after it.
  const lastId = rows.results[rows.results.length - 1]!.id;
  const payload = otlpLogsPayload(rows.results, await telemetryInstanceId(db));

  let delivered = false;
  try {
    const status = await withDeadline(REQUEST_TIMEOUT_MS, async (signal) => {
      const response = await (opts.fetchFn ?? fetch)(`${endpoint}/v1/logs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal,
      });
      await response.body?.cancel();
      return response.status;
    });
    delivered = status >= 200 && status < 300;
    if (!delivered) console.warn(`[telemetry] collector answered ${status}`);
  } catch (error) {
    // Offline, blocked, timed out: all the same answer here.
    console.warn("[telemetry] flush failed:", error);
  }
  if (delivered) {
    await db.prepare("DELETE FROM telemetry_queue WHERE id <= ?").bind(lastId).run();
  } else {
    await db.prepare("UPDATE telemetry_queue SET attempts = attempts + 1 WHERE id <= ?").bind(lastId).run();
  }
}
