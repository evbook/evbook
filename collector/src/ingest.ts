/**
 * The project's telemetry collector: what it accepts from an EVBook instance
 * and how one OTLP/JSON `logs` batch (src/core/telemetry.ts `otlpLogsPayload`)
 * becomes the flat events the Worker logs and counts. Pure, so the Node suite
 * can pin it without workerd.
 *
 * The endpoint is public — anybody can POST to it — so everything here is a
 * bound: on batch size, on attribute count and length, on what an identity may
 * look like. Nothing an instance sends can make one event large or the batch
 * long, and anything that does not look like EVBook is refused outright rather
 * than half-stored.
 */

/** A batch from one instance holds at most 100 rows (FLUSH_BATCH); leave room. */
export const MAX_RECORDS = 200;
/** Ten attributes is the most an event sends today (vehicle.stats); leave room. */
export const MAX_ATTRIBUTES = 40;
/** Stacks are cut at 4 000 characters by the instance already. */
export const MAX_VALUE_LENGTH = 4_096;
const MAX_KEY_LENGTH = 64;

/** `crypto.randomUUID()`, which is all `telemetryInstanceId` ever mints. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VERSION = /^[0-9A-Za-z.+-]{1,32}$/;
/** event.name: `app.install`, `error.client`, `vehicle.stats`… */
const EVENT_NAME = /^[a-z][a-z0-9_.-]{0,63}$/;

export type Scalar = string | number | boolean;

export interface IngestedEvent {
  instance: string;
  version: string;
  event: string;
  severity: "info" | "error";
  /** Milliseconds since the epoch, as recorded on the instance. */
  time: number;
  attributes: Record<string, Scalar>;
}

export class Rejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Rejected";
  }
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One OTLP AnyValue, scalars only — nested arrays/maps are not something EVBook sends. */
function scalar(value: unknown): Scalar | undefined {
  if (!isObject(value)) return undefined;
  if (typeof value.stringValue === "string") return value.stringValue.slice(0, MAX_VALUE_LENGTH);
  if (typeof value.boolValue === "boolean") return value.boolValue;
  if (typeof value.doubleValue === "number" && Number.isFinite(value.doubleValue)) return value.doubleValue;
  // OTLP/JSON carries 64-bit integers as strings; numbers are accepted too.
  if (typeof value.intValue === "string" || typeof value.intValue === "number") {
    const n = Number(value.intValue);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function attributeMap(list: unknown): Record<string, Scalar> {
  const out: Record<string, Scalar> = {};
  if (!Array.isArray(list)) return out;
  for (const entry of list.slice(0, MAX_ATTRIBUTES)) {
    if (!isObject(entry) || typeof entry.key !== "string") continue;
    const key = entry.key.slice(0, MAX_KEY_LENGTH);
    const value = scalar(entry.value);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function eventTime(record: Json, now: number): number {
  const nanos = record.timeUnixNano;
  // Nanoseconds lose sub-microsecond precision as a double; milliseconds do not care.
  const ms = typeof nanos === "string" || typeof nanos === "number" ? Math.round(Number(nanos) / 1e6) : NaN;
  // An instance clock far off (or a missing stamp) is logged at arrival time.
  return Number.isFinite(ms) && ms > 0 && Math.abs(ms - now) < 366 * 24 * 3_600_000 ? ms : now;
}

/**
 * Validate one OTLP/JSON logs body and flatten it. Throws `Rejected` for
 * anything that is not an EVBook batch, so the Worker can answer 400.
 */
export function parseOtlpLogs(body: unknown, now = Date.now()): IngestedEvent[] {
  if (!isObject(body) || !Array.isArray(body.resourceLogs)) throw new Rejected("not an OTLP logs payload");
  const events: IngestedEvent[] = [];
  for (const resourceLogs of body.resourceLogs) {
    if (!isObject(resourceLogs)) throw new Rejected("malformed resourceLogs");
    const resource = attributeMap(isObject(resourceLogs.resource) ? resourceLogs.resource.attributes : undefined);
    if (resource["service.name"] !== "evbook") throw new Rejected("service.name must be evbook");
    const instance = resource["service.instance.id"];
    if (typeof instance !== "string" || !UUID.test(instance)) throw new Rejected("service.instance.id must be a UUID");
    const version = resource["service.version"];
    if (typeof version !== "string" || !VERSION.test(version)) throw new Rejected("service.version is missing");

    const scopes = Array.isArray(resourceLogs.scopeLogs) ? resourceLogs.scopeLogs : [];
    for (const scope of scopes) {
      const records = isObject(scope) && Array.isArray(scope.logRecords) ? scope.logRecords : [];
      for (const record of records) {
        if (!isObject(record)) continue;
        if (events.length >= MAX_RECORDS) throw new Rejected(`more than ${MAX_RECORDS} records`);
        const attributes = attributeMap(record.attributes);
        const event = attributes["event.name"];
        delete attributes["event.name"];
        if (typeof event !== "string" || !EVENT_NAME.test(event)) continue;
        events.push({
          instance: instance.toLowerCase(),
          version,
          event,
          severity: typeof record.severityNumber === "number" && record.severityNumber >= 17 ? "error" : "info",
          time: eventTime(record, now),
          attributes,
        });
      }
    }
  }
  return events;
}

/** A Workers Analytics Engine data point: up to 20 blobs, 20 doubles, one index. */
export interface DataPoint {
  indexes: [string];
  blobs: string[];
  doubles: number[];
}

function num(value: Scalar | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function str(value: Scalar | undefined): string {
  return value === undefined ? "" : String(value).slice(0, 96);
}

/**
 * The long-lived, countable view of one event (Analytics Engine keeps it for
 * three months; Workers Logs keeps the full event for seven days). The column
 * order is the dataset's schema — append, never reorder:
 *
 *   index1  instance id (sampling key, so one chatty instance cannot drown the rest)
 *   blob1   event name          blob2  app version       blob3  severity
 *   blob4   car model           blob5  car firmware      blob6  update: fromVersion
 *   double1 model year          double2 odometer km      double3 capacity kWh
 *   double4 degradation %       double5 degradation-from-new %
 *   double6 rows.cars           double7 rows.drives      double8 rows.charging_processes
 *   double9 rows.positions
 */
export function toDataPoint(event: IngestedEvent): DataPoint {
  const a = event.attributes;
  return {
    indexes: [event.instance],
    blobs: [event.event, event.version, event.severity, str(a.model), str(a.firmware), str(a.fromVersion)],
    doubles: [
      num(a.modelYear),
      num(a.odometerKm),
      num(a.capacityKwh),
      num(a.degradationPercent),
      num(a.degradationFromNewPercent),
      num(a["rows.cars"]),
      num(a["rows.drives"]),
      num(a["rows.charging_processes"]),
      num(a["rows.positions"]),
    ],
  };
}
