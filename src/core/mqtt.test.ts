import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { FULL_SUMMARY } from "../../test/mqtt-summary";
import { carTopics, isValidPrefix, normalizePrefix, payloadOf, snakeCase, topicName } from "./mqtt";

const EXTRAS = { displayName: "Eve", geofence: "Home" };

describe("topic names", () => {
  it("are the summary's fields in snake_case, with the unit where the name lacks it", () => {
    expect(snakeCase("chargeLimitSoc")).toBe("charge_limit_soc");
    expect(topicName("batteryLevel")).toBe("battery_level_pct");
    expect(topicName("odometerKm")).toBe("odometer_km");
    expect(topicName("chargerPower")).toBe("charger_power_kw");
    expect(topicName("tpmsPressureFl")).toBe("tpms_pressure_fl_bar");
    expect(topicName("latitude")).toBe("latitude");
    expect(topicName("locked")).toBe("locked");
  });

  it("leave out what is not a single value, and the car id the topic already carries", () => {
    const names = [...carTopics(FULL_SUMMARY, EXTRAS).keys()];
    for (const nested of ["car_id", "tyres", "maintenance", "active_route", "details"]) {
      expect(names).not.toContain(nested);
    }
    expect(names).toContain("display_name");
    expect(names).toContain("geofence");
  });

  it("are all documented in docs/mqtt.md, and nothing more", () => {
    const docs = readFileSync(join(import.meta.dirname, "../../docs/mqtt.md"), "utf8");
    const table = docs.slice(docs.indexOf("## Topics"), docs.indexOf("## Example"));
    const documented = [...table.matchAll(/^\| `([a-z0-9_]+)` \|/gm)].map((m) => m[1]);
    expect([...documented].sort()).toEqual([...carTopics(FULL_SUMMARY, EXTRAS).keys()].sort());
  });
});

describe("payloads", () => {
  it("are empty for unknown, never 0 or false", () => {
    expect(payloadOf("speedKmh", null)).toBe("");
    expect(payloadOf("locked", null)).toBe("");
    expect(payloadOf("batteryLevel", Number.NaN)).toBe("");
    const topics = carTopics({ ...FULL_SUMMARY, batteryLevel: null }, { displayName: null, geofence: null });
    expect(topics.get("battery_level_pct")).toBe("");
    expect(topics.get("geofence")).toBe("");
    expect(topics.get("display_name")).toBe("");
  });

  it("spell booleans, numbers and instants plainly", () => {
    const topics = carTopics(FULL_SUMMARY, EXTRAS);
    expect(topics.get("locked")).toBe("true");
    expect(topics.get("sentry_mode")).toBe("false");
    expect(topics.get("battery_level_pct")).toBe("57");
    expect(topics.get("tpms_pressure_rl_bar")).toBe("2.875");
    expect(topics.get("since")).toBe("2026-11-14T17:02:00.000Z");
    expect(topics.get("data_at")).toBe("2026-11-14T18:30:00.000Z");
    expect(topics.get("state")).toBe("charging");
    expect(topics.get("geofence")).toBe("Home");
  });
});

describe("prefix", () => {
  it("defaults to evbook and loses stray slashes", () => {
    expect(normalizePrefix("")).toBe("evbook");
    expect(normalizePrefix(null)).toBe("evbook");
    expect(normalizePrefix(" /home/cars/ ")).toBe("home/cars");
  });

  it("refuses wildcards and empty levels", () => {
    expect(isValidPrefix("home/cars")).toBe(true);
    expect(isValidPrefix("home/#")).toBe(false);
    expect(isValidPrefix("home/+/cars")).toBe(false);
    expect(isValidPrefix("home//cars")).toBe(false);
  });
});
