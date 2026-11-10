import { describe, expect, it } from "bun:test";
import { MAX_RECORDS, parseOtlpLogs, Rejected, toDataPoint } from "./ingest";
import { otlpLogsPayload } from "../../src/core/telemetry";
import { APP_VERSION } from "../../shared/version";

const INSTANCE = "0b6f1a7e-2c4d-4e8f-9a1b-3c5d7e9f1a2b";
const NOW = Date.UTC(2026, 10, 9);

function row(id: number, event_name: string, attributes: object, severity = "info") {
  return { id, event_name, severity, attributes: JSON.stringify(attributes), created_at: NOW - 60_000 };
}

describe("parseOtlpLogs", () => {
  it("reads exactly what an instance sends", () => {
    const payload = otlpLogsPayload(
      [
        row(1, "app.install", { version: APP_VERSION }),
        row(2, "vehicle.stats", { car: 1, model: "Model 3", modelYear: 2021, capacityKwh: 71.5 }),
        row(3, "error.server", { message: "boom" }, "error"),
      ],
      INSTANCE,
    );
    const events = parseOtlpLogs(JSON.parse(JSON.stringify(payload)), NOW);
    expect(events).toHaveLength(3);
    expect(events[0]).toEqual({
      instance: INSTANCE,
      version: APP_VERSION,
      event: "app.install",
      severity: "info",
      time: NOW - 60_000,
      attributes: { version: APP_VERSION },
    });
    expect(events[1]!.attributes).toEqual({ car: 1, model: "Model 3", modelYear: 2021, capacityKwh: 71.5 });
    expect(events[2]!.severity).toBe("error");
  });

  it("refuses anything that is not an EVBook batch", () => {
    expect(() => parseOtlpLogs({})).toThrow(Rejected);
    const payload = otlpLogsPayload([row(1, "app.install", {})], "not-a-uuid");
    expect(() => parseOtlpLogs(payload)).toThrow(/UUID/);
    const other = JSON.parse(JSON.stringify(otlpLogsPayload([row(1, "x.y", {})], INSTANCE)));
    other.resourceLogs[0].resource.attributes[0].value.stringValue = "other";
    expect(() => parseOtlpLogs(other)).toThrow(/service.name/);
  });

  it("bounds batch length and value size", () => {
    const rows = Array.from({ length: MAX_RECORDS + 1 }, (_, i) => row(i, "app.update", {}));
    expect(() => parseOtlpLogs(otlpLogsPayload(rows, INSTANCE))).toThrow(/records/);
    const [event] = parseOtlpLogs(otlpLogsPayload([row(1, "error.client", { message: "x".repeat(10_000) })], INSTANCE));
    expect(String(event!.attributes.message)).toHaveLength(4_096);
  });

  it("stamps an implausible clock with arrival time", () => {
    const payload = JSON.parse(JSON.stringify(otlpLogsPayload([row(1, "app.install", {})], INSTANCE)));
    payload.resourceLogs[0].scopeLogs[0].logRecords[0].timeUnixNano = "0";
    expect(parseOtlpLogs(payload, NOW)[0]!.time).toBe(NOW);
  });
});

describe("toDataPoint", () => {
  it("keeps the column order the README's queries rely on", () => {
    const [event] = parseOtlpLogs(
      otlpLogsPayload(
        [row(1, "vehicle.stats", { model: "Model Y", firmware: "2026.32.1", modelYear: 2023, odometerKm: 42000 })],
        INSTANCE,
      ),
    );
    const point = toDataPoint(event!);
    expect(point.indexes).toEqual([INSTANCE]);
    expect(point.blobs.slice(0, 5)).toEqual(["vehicle.stats", APP_VERSION, "info", "Model Y", "2026.32.1"]);
    expect(point.doubles.slice(0, 2)).toEqual([2023, 42000]);
  });
});
