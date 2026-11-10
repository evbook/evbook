import { describe, expect, it } from "bun:test";
import { tessieSource } from "./tessie";
import { memoryBundle } from "../bundle";
import type { ImportBundle, ImportSnapshot } from "../types";

/**
 * Fixture shaped exactly like a Tessie export: one file per metric group, all
 * fields quoted, units in the header, ascending naive-UTC timestamps.
 */
const FILES: Record<string, string> = {
  "driving_states.csv": [
    "Timestamp (UTC),Latitude,Longitude,Shift State,Odometer (mi),Speed (mph)",
    '"2024-05-01 10:00:00","52.52","13.405","P","1000",',
    '"2024-05-01 10:01:00","52.52","13.405","D","1000","0"',
    '"2024-05-01 10:02:00","52.53","13.41","D","1000.62","30"',
    '"2024-05-01 10:03:00","52.54","13.42","P","1001.24",',
    "",
  ].join("\n"),
  "charging_states.csv": [
    "Timestamp (UTC),Charging State,Usable Battery Level (%),Battery Range (mi),Ideal Battery Range (mi),Charge Rate (mph),Charger Current (A),Charger Phases,Charger Power (kW),Charger Voltage (V)",
    '"2024-05-01 10:00:00","Disconnected","80","200","198","0","0",,"0","2"',
    '"2024-05-01 10:03:00","Disconnected","79","198","196","0","0",,"0","2"',
    '"2024-05-01 10:04:00","Charging","79","198","196","20","16","1","11","230"',
    '"2024-05-01 10:05:00","Charging","80","200","198","20","16","1","11","230"',
    '"2024-05-01 10:06:00","Complete","81","202","200","0","0",,"0","2"',
    "",
  ].join("\n"),
  "climate_states.csv": [
    "Timestamp (UTC),Climate Enabled,Inside Temp (°C),Outside Temp (°C)",
    '"2024-05-01 10:00:00","1","21.7","19.5"',
    "",
  ].join("\n"),
  "vehicle_states.csv": [
    "Timestamp (UTC),Locked,Sentry Mode",
    '"2024-05-01 10:00:00","1","0"',
    "",
  ].join("\n"),
  "battery_states.csv": [
    "Timestamp (UTC),Lifetime Energy Used (kWh),Energy Remaining (kWh),Pack Current (A),Pack Voltage (V),Min Battery Module Temp (°C),Max Battery Module Temp (°C)",
    '"2024-05-01 10:02:00","5790.552","60","-100","400","18.5","19"',
    '"2024-05-01 10:04:00","5790.6","59.5","16","400","18.5","19"',
    '"2024-05-01 10:06:00","5790.6","61","0","400","18.5","19"',
    "",
  ].join("\n"),
  "tpms_pressure_fl.csv": ['Timestamp (UTC),Front Left Tire Pressure (Bar)', '"2024-05-01 10:00:00","2.9"', ""].join("\n"),
  "tpms_pressure_fr.csv": "Timestamp (UTC),Front Right Tire Pressure (Bar)\n",
  "tpms_pressure_rl.csv": "Timestamp (UTC),Rear Left Tire Pressure (Bar)\n",
  "tpms_pressure_rr.csv": "Timestamp (UTC),Rear Right Tire Pressure (Bar)\n",
};

const VIN = "LRW3F7EB9MC123456";

function bundle(overrides: Record<string, string> = {}, label = `${VIN}.zip`): ImportBundle {
  return memoryBundle(label, { ...FILES, ...overrides });
}

async function snapshots(source: ImportBundle, options = {}): Promise<ImportSnapshot[]> {
  const out: ImportSnapshot[] = [];
  for await (const snapshot of tessieSource.snapshots(source, options)) {
    // The adapter builds a fresh payload per snapshot, so keeping it is safe.
    out.push(snapshot);
  }
  return out;
}

function at(list: ImportSnapshot[], iso: string): ImportSnapshot {
  const wanted = Date.parse(iso);
  const found = list.find((snapshot) => snapshot.at === wanted);
  if (!found) throw new Error(`no snapshot at ${iso}`);
  return found;
}

describe("detection", () => {
  it("recognises a Tessie export and its VIN", async () => {
    const detection = await tessieSource.detect(bundle());
    expect(detection.confidence).toBe(1);
    expect(detection.vin).toBe(VIN);
    expect(detection.recognised).toContain("driving_states.csv");
    expect(detection.missing).toEqual([]);
  });

  it("still recognises an export missing the optional files", async () => {
    const detection = await tessieSource.detect(
      memoryBundle(`${VIN}.zip`, {
        "driving_states.csv": FILES["driving_states.csv"]!,
        "charging_states.csv": FILES["charging_states.csv"]!,
      }),
    );
    expect(detection.confidence).toBe(1);
    expect(detection.missing).toContain("battery_states.csv");
  });

  it("does not claim a foreign export", async () => {
    const detection = await tessieSource.detect(memoryBundle("teslafi.zip", { "TeslaFi2024.csv": "Date,soc\n" }));
    expect(detection.confidence).toBe(0);
  });

  it("reports an unexpected header rather than guessing", async () => {
    const detection = await tessieSource.detect(bundle({ "charging_states.csv": "Timestamp (UTC),Something Else\n" }));
    expect(detection.confidence).toBeLessThan(1);
    expect(detection.notes.join(" ")).toMatch(/unexpected header/);
  });
});

describe("snapshot reconstruction", () => {
  it("emits one snapshot per distinct timestamp, ascending", async () => {
    const list = await snapshots(bundle());
    expect(list.map((snapshot) => new Date(snapshot.at).toISOString().slice(11, 19))).toEqual([
      "10:00:00",
      "10:01:00",
      "10:02:00",
      "10:03:00",
      "10:04:00",
      "10:05:00",
      "10:06:00",
    ]);
    expect(list.every((snapshot) => snapshot.at === snapshot.data.drive_state?.timestamp)).toBe(true);
  });

  it("maps driving, charging, climate and vehicle columns onto the payload", async () => {
    const snapshot = at(await snapshots(bundle()), "2024-05-01T10:02:00Z");
    expect(snapshot.data.drive_state).toMatchObject({ latitude: 52.53, longitude: 13.41, shift_state: "D", speed: 30 });
    expect(snapshot.data.vehicle_state).toMatchObject({ odometer: 1000.62, locked: true, sentry_mode: false });
    expect(snapshot.data.charge_state).toMatchObject({ charging_state: "Disconnected", battery_range: 200 });
    expect(snapshot.data.climate_state).toMatchObject({ inside_temp: 21.7, outside_temp: 19.5, is_climate_on: true });
    expect(snapshot.data.vehicle_state?.tpms_pressure_fl).toBe(2.9);
    expect(snapshot.data.vehicle_state?.tpms_pressure_fr).toBeNull();
  });

  it("fills in the model from the VIN so the car identifies itself", async () => {
    const list = await snapshots(bundle());
    expect(list[0]!.data.vin).toBe(VIN);
    expect(list[0]!.data.vehicle_config?.car_type).toBe("model3");
  });

  it("normalises metric exports to the units Tesla reports", async () => {
    const metric = bundle({
      "driving_states.csv": [
        "Timestamp (UTC),Latitude,Longitude,Shift State,Odometer (km),Speed (km/h)",
        '"2024-05-01 10:02:00","52.53","13.41","D","1609.34","100"',
        "",
      ].join("\n"),
      "climate_states.csv": [
        "Timestamp (UTC),Climate Enabled,Inside Temp (°F),Outside Temp (°F)",
        '"2024-05-01 10:02:00","1","70","50"',
        "",
      ].join("\n"),
    });
    const snapshot = at(await snapshots(metric), "2024-05-01T10:02:00Z");
    expect(snapshot.data.vehicle_state?.odometer).toBeCloseTo(1000, 1);
    expect(snapshot.data.drive_state?.speed).toBeCloseTo(62.14, 1);
    expect(snapshot.data.climate_state?.inside_temp).toBeCloseTo(21.1, 1);
    expect(snapshot.data.climate_state?.outside_temp).toBeCloseTo(10, 1);
  });

  it("carries the shift state forward — Tessie only writes it when it changes", async () => {
    const list = await snapshots(bundle());
    // Nothing was written at 10:04, but the car is still parked from 10:03.
    expect(at(list, "2024-05-01T10:04:00Z").data.drive_state?.shift_state).toBe("P");
  });

  it("turns pack current and voltage into power, positive while consuming", async () => {
    const list = await snapshots(bundle());
    // Discharging 100 A at 400 V while driving -> +40 kW.
    expect(at(list, "2024-05-01T10:02:00Z").data.drive_state?.power).toBe(40);
    // Charging at 16 A -> negative, as Tesla reports it.
    expect(at(list, "2024-05-01T10:04:00Z").data.drive_state?.power).toBe(-6);
    // No pack row within the age limit -> unknown, not zero.
    expect(at(list, "2024-05-01T10:00:00Z").data.drive_state?.power).toBeNull();
  });

  it("carries the module temperatures the pack file measures", async () => {
    const list = await snapshots(bundle());
    expect(at(list, "2024-05-01T10:04:00Z").data.pack_state).toMatchObject({ temp_min: 18.5, temp_max: 19 });
    // No pack row within the age limit: the battery still had a temperature, so
    // the block is absent rather than reporting one it did not measure.
    expect(at(list, "2024-05-01T10:00:00Z").data.pack_state).toBeNull();
  });

  it("reads module temperatures exported in Fahrenheit", async () => {
    const list = await snapshots(
      bundle({
        "battery_states.csv": [
          "Timestamp (UTC),Energy Remaining (kWh),Pack Current (A),Pack Voltage (V),Min Battery Module Temp (°F),Max Battery Module Temp (°F)",
          '"2024-05-01 10:04:00","59.5","16","400","50","68"',
          "",
        ].join("\n"),
      }),
    );
    const pack = at(list, "2024-05-01T10:04:00Z").data.pack_state;
    expect(pack?.temp_min).toBeCloseTo(10, 6);
    expect(pack?.temp_max).toBeCloseTo(20, 6);
  });

  it("reports charge energy relative to the session, from pack energy", async () => {
    const list = await snapshots(bundle());
    expect(at(list, "2024-05-01T10:04:00Z").data.charge_state?.charge_energy_added).toBe(0);
    // Pack went 59.5 -> 61 kWh; the reading at 10:06 is still within its max age.
    expect(at(list, "2024-05-01T10:06:00Z").data.charge_state?.charge_energy_added).toBe(1.5);
  });

  it("claims no charge energy when the export has no pack energy", async () => {
    const list = await snapshots(bundle({ "battery_states.csv": FILES["battery_states.csv"]!.split("\n")[0] + "\n" }));
    // The charger was delivering 11 kW, but what reached the pack is unmeasured
    // and standing in for it with the wall figure overstates capacity by the
    // charging losses. The charger's own energy still lands in charge_energy_used.
    expect(at(list, "2024-05-01T10:05:00Z").data.charge_state?.charge_energy_added).toBe(0);
    expect(at(list, "2024-05-01T10:05:00Z").data.charge_state?.charger_power).toBe(11);
  });

  it("holds the last pack figure through a gap rather than switching measurement", async () => {
    // Pack rows at 10:04 and 10:06 but nothing after, so 10:20 is past the pack
    // file's max age while the car is still plugged in and drawing 11 kW.
    const list = await snapshots(
      bundle({
        "charging_states.csv": [
          FILES["charging_states.csv"]!.split("\n")[0]!,
          '"2024-05-01 10:04:00","Charging","20","60","58","16","1","11","230"',
          '"2024-05-01 10:06:00","Charging","22","66","64","16","1","11","230"',
          '"2024-05-01 10:20:00","Charging","25","75","73","16","1","11","230"',
          "",
        ].join("\n"),
      }),
    );
    expect(at(list, "2024-05-01T10:20:00Z").data.charge_state?.charge_energy_added).toBe(1.5);
  });

  it("infers DC only from missing phases at real power", async () => {
    const list = await snapshots(bundle());
    expect(at(list, "2024-05-01T10:04:00Z").data.charge_state?.fast_charger_present).toBe(false);
    const dc = bundle({
      "charging_states.csv": [
        FILES["charging_states.csv"]!.split("\n")[0]!,
        '"2024-05-01 10:04:00","Charging","20","60","58","300","400",,"150","400"',
        "",
      ].join("\n"),
    });
    const dcSnapshot = at(await snapshots(dc), "2024-05-01T10:04:00Z");
    expect(dcSnapshot.data.charge_state?.fast_charger_present).toBe(true);
    expect(dcSnapshot.data.charge_state?.charger_phases).toBeNull();
  });

  it("fills in the phase count when Tessie leaves it blank on an AC session", async () => {
    const noPhases = bundle({
      "charging_states.csv": [
        FILES["charging_states.csv"]!.split("\n")[0]!,
        // Mains voltage, so AC: 4 kW at 16 A and 230 V is one phase.
        '"2024-05-01 10:04:00","Charging","74","230","161","0","16",,"4","230"',
        // 11 kW at 16 A and 230 V is three.
        '"2024-05-01 10:05:00","Charging","75","232","163","0","16",,"11","230"',
        "",
      ].join("\n"),
    });
    const list = await snapshots(noPhases);
    expect(at(list, "2024-05-01T10:04:00Z").data.charge_state?.charger_phases).toBe(1);
    expect(at(list, "2024-05-01T10:04:00Z").data.charge_state?.fast_charger_present).toBe(false);
    expect(at(list, "2024-05-01T10:05:00Z").data.charge_state?.charger_phases).toBe(3);
  });

  it("treats a moving car drawing exactly nothing as a gap in the pack data", async () => {
    const zeroed = bundle({
      "battery_states.csv": [
        FILES["battery_states.csv"]!.split("\n")[0]!,
        '"2024-05-01 10:02:00","5790.552","60","0","400","18.5","19"',
        "",
      ].join("\n"),
    });
    // 10:02 is mid-drive at 30 mph, so 0 A cannot be a real reading.
    expect(at(await snapshots(zeroed), "2024-05-01T10:02:00Z").data.drive_state?.power).toBeNull();
    // Parked, 0 A is exactly what it looks like.
    expect(at(await snapshots(zeroed), "2024-05-01T10:03:00Z").data.drive_state?.power).toBe(0);
  });

  it("measures charge energy from the session start, whatever `since` asks for", async () => {
    // A Worker import resumes mid-export, and charging sessions are long. What
    // the adapter reports must not depend on where reading began, or every
    // session spanning a resume point loses most of its energy. The pack reading
    // moves *during* the session, so a baseline taken at the resume point gives a
    // different — wrong — answer.
    const spanning = bundle({
      "battery_states.csv": [
        FILES["battery_states.csv"]!.split("\n")[0]!,
        '"2024-05-01 10:04:00","5790.6","59.5","16","400","18.5","19"',
        '"2024-05-01 10:05:00","5790.6","60","16","400","18.5","19"',
        '"2024-05-01 10:06:00","5790.6","61","0","400","18.5","19"',
        "",
      ].join("\n"),
    });

    const whole = await snapshots(spanning);
    const resumed = await snapshots(spanning, { since: Date.parse("2024-05-01T10:05:00Z") });

    const moment = "2024-05-01T10:06:00Z";
    // 59.5 kWh in the pack when charging started, 61 at the end.
    expect(at(whole, moment).data.charge_state?.charge_energy_added).toBe(1.5);
    expect(at(resumed, moment).data.charge_state?.charge_energy_added).toBe(1.5);
  });

  it("honours a time window", async () => {
    const list = await snapshots(bundle(), {
      since: Date.parse("2024-05-01T10:02:00Z"),
      until: Date.parse("2024-05-01T10:04:00Z"),
    });
    expect(list.map((snapshot) => snapshot.at)).toEqual([
      Date.parse("2024-05-01T10:02:00Z"),
      Date.parse("2024-05-01T10:03:00Z"),
      Date.parse("2024-05-01T10:04:00Z"),
    ]);
  });

  it("thins samples but never drops a transition", async () => {
    const list = await snapshots(bundle(), { minIntervalS: 600 });
    const times = list.map((snapshot) => new Date(snapshot.at).toISOString().slice(11, 19));
    // 10 minutes apart would leave only the first sample; the shift and charging
    // state changes are kept regardless.
    expect(times).toEqual(["10:00:00", "10:01:00", "10:03:00", "10:04:00", "10:06:00"]);
  });

  it("warns about columns it cannot place and periods it has no data for", async () => {
    const warnings: string[] = [];
    for await (const _ of tessieSource.snapshots(bundle(), { warn: (message) => warnings.push(message) })) {
      // drain
    }
    expect(warnings.join("\n")).toMatch(/Charge Rate/);
    expect(warnings.join("\n")).toMatch(/Lifetime Energy Used/);
  });

  it("warns when the pack file starts later than the rest of the export", async () => {
    // Pack rows only from 10:04, an hour and a half after the first sample.
    const late = bundle({
      "driving_states.csv": [
        FILES["driving_states.csv"]!.split("\n")[0]!,
        '"2024-05-01 08:30:00","52.52","13.405","P","1000",',
        ...FILES["driving_states.csv"]!.split("\n").slice(1),
      ].join("\n"),
    });
    const warnings: string[] = [];
    for await (const _ of tessieSource.snapshots(late, { warn: (message) => warnings.push(message) })) {
      // drain
    }
    expect(warnings.join("\n")).toMatch(/pack energy .* only starts 2024-05-01/);
  });

  it("warns when the pack file covers none of the imported period", async () => {
    const warnings: string[] = [];
    const options = { until: Date.parse("2024-05-01T10:01:00Z"), warn: (message: string) => warnings.push(message) };
    for await (const _ of tessieSource.snapshots(bundle(), options)) {
      // drain
    }
    expect(warnings.join("\n")).toMatch(/no pack data/);
  });

  it("refuses an export with none of its files", async () => {
    await expect(snapshots(memoryBundle("empty.zip", { "readme.txt": "" }))).rejects.toThrow(/no Tessie CSV files/);
  });
});
