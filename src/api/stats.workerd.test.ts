import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type {
  BatteryHealthDto,
  CarDto,
  ChargeLevelDto,
  ChargingStatsDto,
  DataHealthDto,
  DriveStatsDto,
  EfficiencyStatsDto,
  OdometerSeriesDto,
  PeriodStatsDto,
  PlaceStatsDto,
  StateTimelineDto,
  TimelineDto,
  TyrePressureDto,
  UpdateDto,
  VampireDrainDto,
} from "@shared/api-types";
import { authed, login } from "../../test/http";
import { resetLoggedCar } from "../../test/seed";

/** HTTP tests for the analytics endpoints and the CSV export. */

const CAR_ID = 9;
const BERLIN = "Europe/Berlin";

/** Local wall-clock time in Berlin as an epoch. */
function berlin(year: number, month: number, day: number, hour = 12): number {
  const naive = Date.UTC(year, month - 1, day, hour);
  const offset = month >= 4 && month <= 9 ? 2 : 1;
  return naive - offset * 3_600_000;
}

const reset = () => resetLoggedCar(CAR_ID, { efficiency: 0.15, timezone: BERLIN });

async function addDrive(at: number, distanceKm: number, rangeUsedKm = 10) {
  const drive = await env.DB.prepare(
    "INSERT INTO drives (car_id, start_date_at, end_date_at, distance, duration_min, start_km, end_km, " +
      "start_rated_range_km, end_rated_range_km, speed_max) VALUES (?, ?, ?, ?, 30, 0, ?, 300, ?, 120) RETURNING id",
  )
    .bind(CAR_ID, at, at + 30 * 60_000, distanceKm, distanceKm, 300 - rangeUsedKm)
    .first<{ id: number }>();

  for (let i = 0; i < 3; i++) {
    await env.DB.prepare(
      "INSERT INTO positions (car_id, drive_id, date_at, latitude, longitude, odometer, battery_level, rated_battery_range_km) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(CAR_ID, drive!.id, at + i * 60_000, 52.5 + i * 0.01, 13.4, i * 10, 80 - i, 300 - i * 5)
      .run();
  }
  return drive!.id;
}

async function addCharge(at: number, energy: number, costCents: number | null, phases: number | null = 3) {
  const cproc = await env.DB.prepare(
    "INSERT INTO charging_processes (car_id, start_date_at, end_date_at, charge_energy_added, charge_energy_used, " +
      "duration_min, start_battery_level, end_battery_level, start_rated_range_km, end_rated_range_km, cost_cents) " +
      "VALUES (?, ?, ?, ?, ?, 60, 30, 80, 100, 280, ?) RETURNING id",
  )
    .bind(CAR_ID, at, at + 3_600_000, energy, energy, costCents)
    .first<{ id: number }>();

  await env.DB.prepare(
    "INSERT INTO charges (charging_process_id, date_at, charge_energy_added, charger_power, charger_phases, " +
      "ideal_battery_range_km, fast_charger_type, fast_charger_present) VALUES (?, ?, ?, 50, ?, 200, ?, ?)",
  )
    .bind(cproc!.id, at, energy, phases, phases == null ? "Combo" : "<invalid>", phases == null ? 1 : 0)
    .run();
  return cproc!.id;
}

describe("period statistics", () => {
  beforeEach(reset);

  it("groups drives and charges by month in the configured zone", async () => {
    const cookie = await login();
    await addDrive(berlin(2026, 6, 10), 100);
    await addDrive(berlin(2026, 6, 20), 50);
    await addDrive(berlin(2026, 7, 5), 30);
    await addCharge(berlin(2026, 6, 11), 20, 600);

    const from = berlin(2026, 5, 1, 0);
    const to = berlin(2026, 8, 1, 0);
    const body = (await (
      await authed(cookie, `/api/v1/stats?period=month&from=${from}&to=${to}`)
    ).json()) as PeriodStatsDto;

    const june = body.buckets.find((b) => b.key === "2026-06");
    const july = body.buckets.find((b) => b.key === "2026-07");
    expect(june?.driveCount).toBe(2);
    expect(june?.distanceKm).toBeCloseTo(150, 5);
    expect(june?.chargeCount).toBe(1);
    expect(june?.costCents).toBe(600);
    expect(july?.driveCount).toBe(1);
    expect(body.timezone).toBe(BERLIN);
  });

  it("puts a late-evening drive in the correct local day", async () => {
    const cookie = await login();
    // 23:30 Berlin on 14 July is 21:30 UTC — still the 14th locally.
    await addDrive(berlin(2026, 7, 14, 23) + 30 * 60_000, 10);

    const from = berlin(2026, 7, 13, 0);
    const to = berlin(2026, 7, 16, 0);
    const body = (await (
      await authed(cookie, `/api/v1/stats?period=day&from=${from}&to=${to}`)
    ).json()) as PeriodStatsDto;

    expect(body.buckets.find((b) => b.key === "2026-07-14")?.driveCount).toBe(1);
    expect(body.buckets.find((b) => b.key === "2026-07-15")?.driveCount).toBe(0);
  });

  it("derives consumption from range used and car efficiency", async () => {
    const cookie = await login();
    // 20 km of range at 0.15 kWh/km = 3 kWh over 100 km = 3 kWh/100 km.
    await addDrive(berlin(2026, 6, 10), 100, 20);
    const from = berlin(2026, 6, 1, 0);
    const to = berlin(2026, 6, 30, 0);
    const body = (await (
      await authed(cookie, `/api/v1/stats?period=month&from=${from}&to=${to}`)
    ).json()) as PeriodStatsDto;
    const june = body.buckets.find((b) => b.key === "2026-06");
    expect(june?.energyUsedKwh).toBeCloseTo(3, 5);
    expect(june?.consumptionKwhPer100km).toBeCloseTo(3, 5);
  });

  it("computes cost per kWh and per distance", async () => {
    const cookie = await login();
    await addDrive(berlin(2026, 6, 10), 200);
    await addCharge(berlin(2026, 6, 10), 40, 1200);
    const from = berlin(2026, 6, 1, 0);
    const to = berlin(2026, 6, 30, 0);
    const body = (await (
      await authed(cookie, `/api/v1/stats?period=month&from=${from}&to=${to}`)
    ).json()) as PeriodStatsDto;
    const june = body.buckets.find((b) => b.key === "2026-06")!;
    expect(june.costPerKwhCents).toBeCloseTo(30, 5);
    expect(june.costPer100kmCents).toBeCloseTo(600, 5);
  });

  /*
    Weekly grouping has to slice weeks the same way the date range picker does, or a
    week selected there covers parts of two buckets here. The picker follows the
    viewer's locale, so the client tells the server which day its weeks start on.
  */
  it("starts weeks on Monday when the client says nothing", async () => {
    const cookie = await login();
    // Sunday 19 July 2026 belongs to the week beginning Monday the 13th.
    await addDrive(berlin(2026, 7, 19), 10);
    const body = (await (
      await authed(cookie, `/api/v1/stats?period=week&from=${berlin(2026, 7, 6, 0)}&to=${berlin(2026, 7, 27, 0)}`)
    ).json()) as PeriodStatsDto;

    const withDrives = body.buckets.filter((b) => b.driveCount > 0);
    expect(withDrives).toHaveLength(1);
    expect(withDrives[0]!.from).toBe(berlin(2026, 7, 13, 0));
    expect(withDrives[0]!.key).toBe("2026-W29");
  });

  it("starts weeks on Sunday when the client asks for it", async () => {
    const cookie = await login();
    // The same drive now belongs to the week beginning Sunday the 19th.
    await addDrive(berlin(2026, 7, 19), 10);
    const body = (await (
      await authed(
        cookie,
        `/api/v1/stats?period=week&weekStart=7&from=${berlin(2026, 7, 6, 0)}&to=${berlin(2026, 7, 27, 0)}`,
      )
    ).json()) as PeriodStatsDto;

    const withDrives = body.buckets.filter((b) => b.driveCount > 0);
    expect(withDrives).toHaveLength(1);
    expect(withDrives[0]!.from).toBe(berlin(2026, 7, 19, 0));
    // An ISO week number would be a lie for a week that does not start on Monday.
    expect(withDrives[0]!.key).toBe("W2026-07-19");
    expect(withDrives[0]!.label).toBe("19 Jul 2026");
  });

  it("puts every bucket a week apart whatever the start day", async () => {
    const cookie = await login();
    const body = (await (
      await authed(
        cookie,
        `/api/v1/stats?period=week&weekStart=6&from=${berlin(2026, 7, 6, 0)}&to=${berlin(2026, 7, 27, 0)}`,
      )
    ).json()) as PeriodStatsDto;

    const starts = body.buckets.map((b) => b.from);
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i]! - starts[i - 1]!).toBe(7 * 86_400_000);
    }
    // Saturday-start weeks, so every bucket begins on a Saturday.
    for (const start of starts) expect(new Date(start + 12 * 3_600_000).getUTCDay()).toBe(6);
  });

  it("rejects a week start outside 1-7", async () => {
    const cookie = await login();
    for (const value of ["0", "8", "-1"]) {
      const response = await authed(cookie, `/api/v1/stats?period=week&weekStart=${value}`);
      expect(response.status).toBe(400);
    }
  });

  it("filters by car", async () => {
    const cookie = await login();
    await addDrive(berlin(2026, 6, 10), 100);
    const from = berlin(2026, 6, 1, 0);
    const to = berlin(2026, 6, 30, 0);

    const mine = (await (
      await authed(cookie, `/api/v1/stats?period=month&from=${from}&to=${to}&carId=${CAR_ID}`)
    ).json()) as PeriodStatsDto;
    expect(mine.buckets.find((b) => b.key === "2026-06")?.driveCount).toBe(1);

    const other = (await (
      await authed(cookie, `/api/v1/stats?period=month&from=${from}&to=${to}&carId=999`)
    ).json()) as PeriodStatsDto;
    expect(other.buckets.find((b) => b.key === "2026-06")?.driveCount).toBe(0);
  });

  it("rejects an unknown period", async () => {
    const cookie = await login();
    expect((await authed(cookie, "/api/v1/stats?period=fortnight")).status).toBe(400);
  });
});

describe("charging statistics", () => {
  beforeEach(reset);

  it("splits AC from DC", async () => {
    const cookie = await login();
    await addCharge(berlin(2026, 6, 10), 20, 500, 3);
    await addCharge(berlin(2026, 6, 11), 40, 2000, null);

    const from = berlin(2026, 6, 1, 0);
    const to = berlin(2026, 6, 30, 0);
    const body = (await (
      await authed(cookie, `/api/v1/stats/charging?from=${from}&to=${to}`)
    ).json()) as ChargingStatsDto;

    expect(body.ac.count).toBe(1);
    expect(body.ac.energyKwh).toBeCloseTo(20, 5);
    expect(body.dc.count).toBe(1);
    expect(body.dc.energyKwh).toBeCloseTo(40, 5);
  });

  it("ranks locations by energy", async () => {
    const cookie = await login();
    const position = await env.DB.prepare(
      "INSERT INTO positions (car_id, date_at, latitude, longitude) VALUES (?, 0, 52.52, 13.4) RETURNING id",
    )
      .bind(CAR_ID)
      .first<{ id: number }>();
    await env.DB.prepare(
      "INSERT INTO geofences (id, name, latitude, longitude, radius, inserted_at, updated_at) VALUES (1, 'Home', 52.52, 13.4, 500, 0, 0)",
    ).run();
    const id = await addCharge(berlin(2026, 6, 10), 25, 700);
    await env.DB.prepare("UPDATE charging_processes SET geofence_id = 1, position_id = ? WHERE id = ?")
      .bind(position!.id, id)
      .run();

    const from = berlin(2026, 6, 1, 0);
    const to = berlin(2026, 6, 30, 0);
    const body = (await (
      await authed(cookie, `/api/v1/stats/charging?from=${from}&to=${to}`)
    ).json()) as ChargingStatsDto;
    expect(body.topLocations[0]).toMatchObject({ label: "Home", count: 1 });
  });

  it("buckets sessions by starting state of charge", async () => {
    const cookie = await login();
    await addCharge(berlin(2026, 6, 10), 20, 500);
    const from = berlin(2026, 6, 1, 0);
    const to = berlin(2026, 6, 30, 0);
    const body = (await (
      await authed(cookie, `/api/v1/stats/charging?from=${from}&to=${to}`)
    ).json()) as ChargingStatsDto;
    // Sessions are seeded starting at 30%.
    expect(body.startSocBands).toEqual([{ band: 30, count: 1, energyKwh: 20 }]);
  });

  it("keeps sessions that moved no energy out of the roll-up entirely", async () => {
    const cookie = await login();
    await addCharge(berlin(2026, 6, 10), 20, 500, 3);
    // Plugged in and nothing happened. Under the old rule this counted as a DC
    // session, so a home AC charger showed up in the DC column having charged 0 kWh.
    const empty = await addCharge(berlin(2026, 6, 11), 0, 0, null);
    await env.DB.prepare("UPDATE charging_processes SET charge_energy_added = 0, charge_energy_used = 0 WHERE id = ?")
      .bind(empty)
      .run();

    const from = berlin(2026, 6, 1, 0);
    const to = berlin(2026, 6, 30, 0);
    const body = (await (
      await authed(cookie, `/api/v1/stats/charging?from=${from}&to=${to}`)
    ).json()) as ChargingStatsDto;

    expect(body.ac.count).toBe(1);
    expect(body.dc.count).toBe(0);
    expect(body.dc.energyKwh).toBeNull();
    // And it is not hiding in the heatmap or the location roll-up either.
    expect(body.heatmap.reduce((total, cell) => total + cell.count, 0)).toBe(1);
    expect(body.topLocations.reduce((total, place) => total + place.count, 0)).toBe(1);
  });

  it("says nothing about Superchargers when the car never names a brand", async () => {
    const cookie = await login();
    // A real DC session, but this car does not populate fast_charger_brand.
    await addCharge(berlin(2026, 6, 10), 40, 2000, null);

    const from = berlin(2026, 6, 1, 0);
    const to = berlin(2026, 6, 30, 0);
    const body = (await (
      await authed(cookie, `/api/v1/stats/charging?from=${from}&to=${to}`)
    ).json()) as ChargingStatsDto;

    expect(body.dc.count).toBe(1);
    // Null, not zero: "none of it" and "cannot say" are different answers.
    expect(body.superchargerCostCents).toBeNull();
    expect(body.totalCostCents).toBe(2000);
  });

  it("puts the spend against the distance driven", async () => {
    const cookie = await login();
    await addDrive(berlin(2026, 6, 10), 200);
    await addCharge(berlin(2026, 6, 10), 40, 1200);

    const from = berlin(2026, 6, 1, 0);
    const to = berlin(2026, 6, 30, 0);
    const body = (await (
      await authed(cookie, `/api/v1/stats/charging?from=${from}&to=${to}`)
    ).json()) as ChargingStatsDto;

    expect(body.distanceKm).toBeCloseTo(200, 5);
    expect(body.totalCostCents).toBe(1200);
    // 12.00 over 200 km is 6.00 per 100 km.
    expect(body.costPer100kmCents).toBeCloseTo(600, 5);
  });

  it("separates what went to Superchargers from the rest of the spend", async () => {
    const cookie = await login();
    // A DC session at a Tesla stall, and an AC one at home.
    const supercharged = await addCharge(berlin(2026, 6, 10), 40, 2000, null);
    await env.DB.prepare("UPDATE charges SET fast_charger_brand = 'Tesla' WHERE charging_process_id = ?")
      .bind(supercharged)
      .run();
    await addCharge(berlin(2026, 6, 11), 20, 300, 3);

    const from = berlin(2026, 6, 1, 0);
    const to = berlin(2026, 6, 30, 0);
    const body = (await (
      await authed(cookie, `/api/v1/stats/charging?from=${from}&to=${to}`)
    ).json()) as ChargingStatsDto;

    expect(body.totalCostCents).toBe(2300);
    expect(body.superchargerCostCents).toBe(2000);
    // The AC/DC split still totals correctly now that it groups by two things.
    expect(body.ac.count).toBe(1);
    expect(body.ac.costCents).toBe(300);
    expect(body.dc.count).toBe(1);
    expect(body.dc.costCents).toBe(2000);
  });

  it("ranks locations by cost as well as by energy", async () => {
    const cookie = await login();
    await env.DB.prepare(
      "INSERT INTO geofences (id, name, latitude, longitude, radius, inserted_at, updated_at) " +
        "VALUES (2, 'Home', 52.52, 13.4, 500, 0, 0), (3, 'Motorway', 51.0, 13.0, 500, 0, 0)",
    ).run();
    // Lots of cheap energy at home, one expensive stop on the motorway.
    const home = await addCharge(berlin(2026, 6, 10), 100, 500);
    await env.DB.prepare("UPDATE charging_processes SET geofence_id = 2 WHERE id = ?").bind(home).run();
    const motorway = await addCharge(berlin(2026, 6, 11), 20, 4000);
    await env.DB.prepare("UPDATE charging_processes SET geofence_id = 3 WHERE id = ?").bind(motorway).run();

    const from = berlin(2026, 6, 1, 0);
    const to = berlin(2026, 6, 30, 0);
    const body = (await (
      await authed(cookie, `/api/v1/stats/charging?from=${from}&to=${to}`)
    ).json()) as ChargingStatsDto;

    // The two orderings disagree, which is the whole reason both exist.
    expect(body.topLocations[0]!.label).toBe("Home");
    expect(body.topByCost[0]!.label).toBe("Motorway");
  });

  it("bands the sessions by local weekday and hour", async () => {
    const cookie = await login();
    // 10 June 2026 is a Wednesday. 14:00 Berlin, twice, plus one at 09:00.
    await addCharge(berlin(2026, 6, 10, 14), 10, 100);
    await addCharge(berlin(2026, 6, 17, 14), 10, 100);
    await addCharge(berlin(2026, 6, 11, 9), 5, 50);

    const from = berlin(2026, 6, 1, 0);
    const to = berlin(2026, 6, 30, 0);
    const body = (await (
      await authed(cookie, `/api/v1/stats/charging?from=${from}&to=${to}`)
    ).json()) as ChargingStatsDto;

    // Wednesday is ISO day 3, Thursday 4 — local days, not UTC ones.
    expect(body.heatmap).toEqual([
      { weekday: 3, hour: 14, count: 2, energyKwh: 20 },
      { weekday: 4, hour: 9, count: 1, energyKwh: 5 },
    ]);
  });

  it("averages the DC taper across sessions, ignoring the AC ones", async () => {
    const cookie = await login();
    const dc = await addCharge(berlin(2026, 6, 10), 40, 2000, null);
    // A DC session tapering from 120 kW at 20% to 40 kW at 70%.
    const taper: [level: number, power: number][] = [
      [20, 120],
      [25, 110],
      [70, 40],
    ];
    for (const [level, power] of taper) {
      await env.DB.prepare(
        "INSERT INTO charges (charging_process_id, date_at, battery_level, charge_energy_added, charger_power, " +
          "charger_phases, ideal_battery_range_km) VALUES (?, ?, ?, 1, ?, NULL, 200)",
      )
        .bind(dc, berlin(2026, 6, 10) + level * 1000, level, power)
        .run();
    }
    // An AC session at a steady 11 kW, which must not flatten the curve.
    const ac = await addCharge(berlin(2026, 6, 12), 20, 300, 3);
    await env.DB.prepare(
      "INSERT INTO charges (charging_process_id, date_at, battery_level, charge_energy_added, charger_power, " +
        "charger_phases, ideal_battery_range_km) VALUES (?, ?, 25, 1, 11, 3, 200)",
    )
      .bind(ac, berlin(2026, 6, 12))
      .run();

    const from = berlin(2026, 6, 1, 0);
    const to = berlin(2026, 6, 30, 0);
    const body = (await (
      await authed(cookie, `/api/v1/stats/charging?from=${from}&to=${to}`)
    ).json()) as ChargingStatsDto;

    const at20 = body.dcCurve.find((point) => point.band === 20)!;
    const at70 = body.dcCurve.find((point) => point.band === 70)!;
    // 120 and 110 both fall in the 20 % band; the AC sample at 25 % is excluded.
    expect(at20.samples).toBe(2);
    expect(at20.avgPowerKw).toBeCloseTo(115, 5);
    expect(at70.avgPowerKw).toBeCloseTo(40, 5);
    expect(body.dcCurve.every((point) => point.avgPowerKw! > 11)).toBe(true);
  });
});

describe("battery health", () => {
  beforeEach(reset);

  it("derives capacity from sessions that filled a meaningful share", async () => {
    const cookie = await login();
    // 25 kWh added for 50 percentage points implies a 50 kWh usable pack.
    for (let i = 0; i < 3; i++) {
      await env.DB.prepare(
        "INSERT INTO charging_processes (car_id, start_date_at, end_date_at, charge_energy_added, duration_min, " +
          "start_battery_level, end_battery_level, start_rated_range_km, end_rated_range_km) " +
          "VALUES (?, ?, ?, 25, 60, 30, 80, 100, 240)",
      )
        .bind(CAR_ID, berlin(2026, 6, 10 + i), berlin(2026, 6, 10 + i) + 3_600_000)
        .run();
    }
    const body = (await (
      await authed(cookie, `/api/v1/stats/battery-health?carId=${CAR_ID}`)
    ).json()) as BatteryHealthDto;
    expect(body.points).toHaveLength(3);
    expect(body.currentCapacityKwh).toBeCloseTo(50, 5);
    // 240 km at 80% implies 300 km at 100%.
    expect(body.currentRangeAt100Km).toBeCloseTo(300, 5);
    // The seed's placeholder VIN says nothing about the pack when new.
    expect(body.newCapacityKwh).toBeNull();
    expect(body.degradationFromNewPercent).toBeNull();
  });

  it("measures degradation against the pack the VIN says the car left with", async () => {
    // A 2019 Fremont Model 3 Standard Range: ≈50 kWh usable when new.
    await resetLoggedCar(CAR_ID, { vin: "5YJ3E1EA7KF000001" });
    const cookie = await login();
    // 22.5 kWh over 50 points implies 45 kWh — a tenth of the pack gone.
    await env.DB.prepare(
      "INSERT INTO charging_processes (car_id, start_date_at, end_date_at, charge_energy_added, duration_min, " +
        "start_battery_level, end_battery_level) VALUES (?, ?, ?, 22.5, 60, 30, 80)",
    )
      .bind(CAR_ID, berlin(2026, 6, 10), berlin(2026, 6, 10) + 3_600_000)
      .run();
    const body = (await (
      await authed(cookie, `/api/v1/stats/battery-health?carId=${CAR_ID}`)
    ).json()) as BatteryHealthDto;
    expect(body.newCapacityKwh).toBe(50);
    expect(body.degradationFromNewPercent).toBeCloseTo(10, 5);
    // The since-first-measured figure still reads zero: the loss predates the log.
    expect(body.degradationPercent).toBeCloseTo(0, 5);
  });

  it("lets the owner's pack pick outrank the VIN's blended figure", async () => {
    // A 2021 Shanghai Model 3 LR: the VIN cannot split BT38 from BT43, so it
    // reads the BT38 the year mostly shipped — until the owner says otherwise.
    await resetLoggedCar(CAR_ID, { vin: "LRW3F7EB9MC123456" });
    const cookie = await login();
    await env.DB.prepare("UPDATE car_settings SET usable_when_new_kwh = 74 WHERE car_id = ?").bind(CAR_ID).run();
    // 33.5 kWh over 50 points implies 67 kWh usable now.
    await env.DB.prepare(
      "INSERT INTO charging_processes (car_id, start_date_at, end_date_at, charge_energy_added, duration_min, " +
        "start_battery_level, end_battery_level) VALUES (?, ?, ?, 33.5, 60, 30, 80)",
    )
      .bind(CAR_ID, berlin(2026, 6, 10), berlin(2026, 6, 10) + 3_600_000)
      .run();

    const body = (await (
      await authed(cookie, `/api/v1/stats/battery-health?carId=${CAR_ID}`)
    ).json()) as BatteryHealthDto;
    expect(body.newCapacityKwh).toBe(74);
    expect(body.degradationFromNewPercent).toBeCloseTo(((74 - 67) / 74) * 100, 5);
  });

  it("ignores small top-ups that would skew the estimate", async () => {
    const cookie = await login();
    await env.DB.prepare(
      "INSERT INTO charging_processes (car_id, start_date_at, end_date_at, charge_energy_added, duration_min, " +
        "start_battery_level, end_battery_level) VALUES (?, ?, ?, 2, 10, 70, 75)",
    )
      .bind(CAR_ID, berlin(2026, 6, 10), berlin(2026, 6, 10) + 600_000)
      .run();
    const body = (await (
      await authed(cookie, `/api/v1/stats/battery-health?carId=${CAR_ID}`)
    ).json()) as BatteryHealthDto;
    expect(body.points).toHaveLength(0);
    expect(body.currentCapacityKwh).toBeNull();
  });

  it("requires a car id", async () => {
    const cookie = await login();
    expect((await authed(cookie, "/api/v1/stats/battery-health")).status).toBe(400);
  });

  /** A completed session from `start` to `end` percent, reporting `energy` kWh added. */
  async function addHealthSession(at: number, start: number, end: number, energy: number) {
    const row = await env.DB.prepare(
      "INSERT INTO charging_processes (car_id, start_date_at, end_date_at, charge_energy_added, duration_min, " +
        "start_battery_level, end_battery_level) VALUES (?, ?, ?, ?, 60, ?, ?) RETURNING id",
    )
      .bind(CAR_ID, at, at + 3_600_000, energy, start, end)
      .first<{ id: number }>();
    return row!.id;
  }

  /** One in-session sample; extras cover the columns the health query inspects. */
  async function addSample(
    pid: number,
    at: number,
    level: number,
    energy: number,
    extra: { usable?: number; heaterOn?: number } = {},
  ) {
    await env.DB.prepare(
      "INSERT INTO charges (charging_process_id, date_at, battery_level, usable_battery_level, " +
        "charge_energy_added, battery_heater_on, charger_power, ideal_battery_range_km) VALUES (?, ?, ?, ?, ?, ?, 11, 200)",
    )
      .bind(pid, at, level, extra.usable ?? level, energy, extra.heaterOn ?? 0)
      .run();
  }

  it("measures between level ticks when samples exist, beating the rounded endpoints", async () => {
    const cookie = await login();
    // The endpoints read 30 → 80 for 26 kWh — 52 kWh if taken at face value.
    // The samples show 31 first appeared at 0.5 kWh and 79 at 24.5: 24 kWh over
    // 48 true points, a 50 kWh pack. The final percent cost 1.5 kWh on its own,
    // the padding a charge limit puts there, and is left out of both.
    const at = berlin(2026, 6, 10);
    const pid = await addHealthSession(at, 30, 80, 26);
    await addSample(pid, at, 30, 0);
    await addSample(pid, at + 60_000, 31, 0.5);
    await addSample(pid, at + 3_400_000, 79, 24.5);
    await addSample(pid, at + 3_500_000, 80, 26);

    const body = (await (
      await authed(cookie, `/api/v1/stats/battery-health?carId=${CAR_ID}`)
    ).json()) as BatteryHealthDto;
    expect(body.points).toHaveLength(1);
    expect(body.currentCapacityKwh).toBeCloseTo(50, 5);
  });

  it("drops a short session outright rather than measuring it by its endpoints", async () => {
    const cookie = await login();
    // A clean long session implying 50 kWh.
    await addHealthSession(berlin(2026, 6, 10), 30, 80, 25);
    // A 38 → 50 top-up: wide enough for the endpoint path, which would read
    // 8.6 kWh over 12 points as 71.7 kWh. Its ticks span only 5 points once the
    // final percent goes, so it is not measured at all — an eighth of the pack
    // cannot carry a session's worth of overhead without inventing capacity.
    const short = await addHealthSession(berlin(2026, 6, 11), 38, 50, 8.6);
    await addSample(short, berlin(2026, 6, 11), 38, 0);
    await addSample(short, berlin(2026, 6, 11) + 600_000, 44, 4);
    await addSample(short, berlin(2026, 6, 11) + 1_200_000, 49, 7.4);
    await addSample(short, berlin(2026, 6, 11) + 1_800_000, 50, 8.6);

    const body = (await (
      await authed(cookie, `/api/v1/stats/battery-health?carId=${CAR_ID}`)
    ).json()) as BatteryHealthDto;
    expect(body.points).toHaveLength(1);
    expect(body.currentCapacityKwh).toBeCloseTo(50, 5);
  });

  it("drops sessions the pack spent being heated or cold-capped", async () => {
    const cookie = await login();
    // A clean session implying 50 kWh.
    await addHealthSession(berlin(2026, 6, 10), 30, 80, 25);
    // A heated one implying 60 kWh — energy went into warmth, not the estimate.
    const heated = await addHealthSession(berlin(2026, 6, 11), 30, 80, 30);
    await addSample(heated, berlin(2026, 6, 11), 30, 0, { heaterOn: 1 });
    await addSample(heated, berlin(2026, 6, 11) + 60_000, 31, 0.6);
    await addSample(heated, berlin(2026, 6, 11) + 3_500_000, 80, 30);
    // A cold-capped one: usable level starts below the displayed level.
    const cold = await addHealthSession(berlin(2026, 6, 12), 30, 80, 30);
    await addSample(cold, berlin(2026, 6, 12), 30, 0, { usable: 27 });
    await addSample(cold, berlin(2026, 6, 12) + 60_000, 31, 0.6);
    await addSample(cold, berlin(2026, 6, 12) + 3_500_000, 80, 30);

    const body = (await (
      await authed(cookie, `/api/v1/stats/battery-health?carId=${CAR_ID}`)
    ).json()) as BatteryHealthDto;
    expect(body.points).toHaveLength(1);
    expect(body.currentCapacityKwh).toBeCloseTo(50, 5);
  });

  it("fits a slope across sessions so fixed overhead lands in the intercept", async () => {
    const cookie = await login();
    // Each session carries 0.5 kWh of overhead on top of 0.5 kWh per point.
    // Averaging the ratios books the overhead as capacity (≈52.4 kWh); the
    // fitted slope reads the true 50 and leaves the 0.5 in the intercept.
    const shapes: [start: number, end: number, energy: number][] = [
      [70, 80, 5.5],
      [60, 80, 10.5],
      [40, 80, 20.5],
      [20, 80, 30.5],
    ];
    for (let i = 0; i < shapes.length; i++) {
      const [start, end, energy] = shapes[i]!;
      await addHealthSession(berlin(2026, 6, 10 + i), start, end, energy);
    }

    const body = (await (
      await authed(cookie, `/api/v1/stats/battery-health?carId=${CAR_ID}`)
    ).json()) as BatteryHealthDto;
    expect(body.currentCapacityKwh).toBeCloseTo(50, 5);
  });

  it("reads current capacity from a recent window, not the last few sessions", async () => {
    const cookie = await login();
    // Five winter-adjacent sessions a year ago at 52 kWh…
    for (let i = 0; i < 5; i++) {
      await addHealthSession(berlin(2025, 6, 1 + i * 7), 30, 80, 26);
    }
    // …and four recent ones at 48 kWh.
    for (let i = 0; i < 4; i++) {
      await addHealthSession(berlin(2026, 6, 1 + i * 7), 30, 80, 24);
    }

    const body = (await (
      await authed(cookie, `/api/v1/stats/battery-health?carId=${CAR_ID}`)
    ).json()) as BatteryHealthDto;
    // The old sessions form the baseline, the recent window the current figure.
    expect(body.currentCapacityKwh).toBeCloseTo(48, 5);
    expect(body.originalCapacityKwh).toBeCloseTo(52, 5);
    expect(body.degradationPercent).toBeCloseTo(((52 - 48) / 52) * 100, 5);
  });
});

describe("vampire drain", () => {
  beforeEach(reset);

  it("reports range lost while parked between drives", async () => {
    const cookie = await login();
    const day = berlin(2026, 6, 10, 8);

    const first = await env.DB.prepare(
      "INSERT INTO drives (car_id, start_date_at, end_date_at) VALUES (?, ?, ?) RETURNING id",
    )
      .bind(CAR_ID, day, day + 1_800_000)
      .first<{ id: number }>();
    const endPos = await env.DB.prepare(
      "INSERT INTO positions (car_id, date_at, rated_battery_range_km, battery_level, latitude, longitude) " +
        "VALUES (?, ?, 300, 80, 52.5, 13.4) RETURNING id",
    )
      .bind(CAR_ID, day + 1_800_000)
      .first<{ id: number }>();
    await env.DB.prepare("UPDATE drives SET end_position_id = ? WHERE id = ?").bind(endPos!.id, first!.id).run();

    // Next drive starts 10 hours later with 8 km less range.
    const later = day + 12 * 3_600_000;
    const second = await env.DB.prepare(
      "INSERT INTO drives (car_id, start_date_at, end_date_at) VALUES (?, ?, ?) RETURNING id",
    )
      .bind(CAR_ID, later, later + 1_800_000)
      .first<{ id: number }>();
    const startPos = await env.DB.prepare(
      "INSERT INTO positions (car_id, date_at, rated_battery_range_km, battery_level, latitude, longitude) " +
        "VALUES (?, ?, 292, 78, 52.5, 13.4) RETURNING id",
    )
      .bind(CAR_ID, later)
      .first<{ id: number }>();
    await env.DB.prepare("UPDATE drives SET start_position_id = ? WHERE id = ?").bind(startPos!.id, second!.id).run();

    const body = (await (
      await authed(cookie, `/api/v1/stats/vampire-drain?carId=${CAR_ID}&minHours=4`)
    ).json()) as VampireDrainDto;

    expect(body.periods).toHaveLength(1);
    expect(body.periods[0]!.rangeLostKm).toBeCloseTo(8, 5);
    expect(body.periods[0]!.socLost).toBe(2);
    expect(body.periods[0]!.hours).toBeCloseTo(11.5, 1);
  });

  it("ignores idle periods that include a charge", async () => {
    const cookie = await login();
    const day = berlin(2026, 6, 10, 8);

    const first = await env.DB.prepare(
      "INSERT INTO drives (car_id, start_date_at, end_date_at) VALUES (?, ?, ?) RETURNING id",
    )
      .bind(CAR_ID, day, day + 1_800_000)
      .first<{ id: number }>();
    const endPos = await env.DB.prepare(
      "INSERT INTO positions (car_id, date_at, rated_battery_range_km, battery_level) VALUES (?, ?, 300, 80) RETURNING id",
    )
      .bind(CAR_ID, day + 1_800_000)
      .first<{ id: number }>();
    await env.DB.prepare("UPDATE drives SET end_position_id = ? WHERE id = ?").bind(endPos!.id, first!.id).run();

    const later = day + 12 * 3_600_000;
    const second = await env.DB.prepare(
      "INSERT INTO drives (car_id, start_date_at, end_date_at) VALUES (?, ?, ?) RETURNING id",
    )
      .bind(CAR_ID, later, later + 1_800_000)
      .first<{ id: number }>();
    const startPos = await env.DB.prepare(
      "INSERT INTO positions (car_id, date_at, rated_battery_range_km, battery_level) VALUES (?, ?, 292, 78) RETURNING id",
    )
      .bind(CAR_ID, later)
      .first<{ id: number }>();
    await env.DB.prepare("UPDATE drives SET start_position_id = ? WHERE id = ?").bind(startPos!.id, second!.id).run();

    await addCharge(day + 4 * 3_600_000, 10, 300);

    const body = (await (
      await authed(cookie, `/api/v1/stats/vampire-drain?carId=${CAR_ID}&minHours=4`)
    ).json()) as VampireDrainDto;
    expect(body.periods).toHaveLength(0);
  });
});

describe("state timeline", () => {
  beforeEach(reset);

  const HOUR = 3_600_000;

  async function addState(state: string, from: number, to: number | null) {
    await env.DB.prepare("INSERT INTO states (car_id, state, start_date_at, end_date_at) VALUES (?, ?, ?, ?)")
      .bind(CAR_ID, state, from, to)
      .run();
  }

  it("overlays drives and charges onto the logged states", async () => {
    const cookie = await login();
    const day = berlin(2026, 6, 10, 0);

    await addState("asleep", day, day + 8 * HOUR);
    await addState("online", day + 8 * HOUR, day + 12 * HOUR);
    // Driving 09:00–10:00, charging 10:30–11:30, both inside the online period.
    await env.DB.prepare("INSERT INTO drives (car_id, start_date_at, end_date_at) VALUES (?, ?, ?)")
      .bind(CAR_ID, day + 9 * HOUR, day + 10 * HOUR)
      .run();
    await env.DB.prepare(
      "INSERT INTO charging_processes (car_id, start_date_at, end_date_at, charge_energy_added) VALUES (?, ?, ?, 10)",
    )
      .bind(CAR_ID, day + 10.5 * HOUR, day + 11.5 * HOUR)
      .run();

    const body = (await (
      await authed(cookie, `/api/v1/stats/states?carId=${CAR_ID}&from=${day}&to=${day + 12 * HOUR}`)
    ).json()) as StateTimelineDto;

    expect(body.spans.map((s) => s.state)).toEqual(["asleep", "online", "driving", "online", "charging", "online"]);
    const asleep = body.totals.find((t) => t.state === "asleep")!;
    expect(asleep.ms).toBe(8 * HOUR);
    expect(asleep.share).toBeCloseTo(8 / 12, 5);
    expect(body.totals.find((t) => t.state === "driving")?.ms).toBe(HOUR);
  });

  it("reports a stretch with nothing logged as unknown", async () => {
    const cookie = await login();
    const day = berlin(2026, 6, 10, 0);
    await addState("asleep", day, day + 2 * HOUR);

    const body = (await (
      await authed(cookie, `/api/v1/stats/states?carId=${CAR_ID}&from=${day}&to=${day + 4 * HOUR}`)
    ).json()) as StateTimelineDto;

    expect(body.spans).toEqual([
      { state: "asleep", from: day, to: day + 2 * HOUR },
      { state: "unknown", from: day + 2 * HOUR, to: day + 4 * HOUR },
    ]);
  });

  it("reads the current state from the open-ended row, whatever the window", async () => {
    const cookie = await login();
    const past = berlin(2026, 6, 10, 0);
    await addState("asleep", past, past + HOUR);
    // Still online now, long after the window the caller asked about.
    await addState("online", Date.now() - HOUR, null);

    const body = (await (
      await authed(cookie, `/api/v1/stats/states?carId=${CAR_ID}&from=${past}&to=${past + HOUR}`)
    ).json()) as StateTimelineDto;
    expect(body.current?.state).toBe("online");
  });

  it("prefers an open drive over the open state row", async () => {
    const cookie = await login();
    await addState("online", Date.now() - HOUR, null);
    await env.DB.prepare("INSERT INTO drives (car_id, start_date_at) VALUES (?, ?)")
      .bind(CAR_ID, Date.now() - 600_000)
      .run();

    const body = (await (await authed(cookie, `/api/v1/stats/states?carId=${CAR_ID}`)).json()) as StateTimelineDto;
    expect(body.current?.state).toBe("driving");
  });

  it("never runs an unfinished span past the present", async () => {
    const cookie = await login();
    const now = Date.now();
    await addState("online", now - HOUR, null);

    const to = now + 24 * HOUR;
    const body = (await (
      await authed(cookie, `/api/v1/stats/states?carId=${CAR_ID}&from=${now - 2 * HOUR}&to=${to}`)
    ).json()) as StateTimelineDto;

    const last = body.spans[body.spans.length - 1]!;
    expect(last.state).toBe("unknown");
    expect(last.to).toBe(to);
    // The online span stops at roughly now, not at the end of the window.
    expect(body.spans.find((s) => s.state === "online")!.to).toBeLessThanOrEqual(now + 5_000);
  });

  it("stops drawing a drive that was never closed, so what is under it shows", async () => {
    const cookie = await login();
    const now = Date.now();
    const day = now - 3 * 24 * HOUR;

    // The fault: a drive from weeks ago with no end. Driving outranks charging,
    // so before the cap this one span covered the window and hid the charge.
    await env.DB.prepare("INSERT INTO drives (car_id, start_date_at) VALUES (?, ?)")
      .bind(CAR_ID, now - 8 * 7 * 24 * HOUR)
      .run();
    await addState("online", day, day + 4 * HOUR);
    await env.DB.prepare(
      "INSERT INTO charging_processes (car_id, start_date_at, end_date_at, charge_energy_added) VALUES (?, ?, ?, 10)",
    )
      .bind(CAR_ID, day + HOUR, day + 2 * HOUR)
      .run();
    // What the car is actually doing, which the open drive was answering over.
    await addState("online", now - HOUR, null);

    const body = (await (
      await authed(cookie, `/api/v1/stats/states?carId=${CAR_ID}&from=${day}&to=${day + 4 * HOUR}`)
    ).json()) as StateTimelineDto;

    expect(body.spans.map((s) => s.state)).toEqual(["online", "charging", "online"]);
    expect(body.totals.find((t) => t.state === "driving")).toBeUndefined();
    // And it is not the answer to what the car is doing right now either.
    expect(body.current?.state).toBe("online");
  });

  it("still draws an open drive that is genuinely current", async () => {
    const cookie = await login();
    const now = Date.now();
    await addState("online", now - 2 * HOUR, null);
    await env.DB.prepare("INSERT INTO drives (car_id, start_date_at) VALUES (?, ?)")
      .bind(CAR_ID, now - 30 * 60_000)
      .run();

    const body = (await (
      await authed(cookie, `/api/v1/stats/states?carId=${CAR_ID}&from=${now - 2 * HOUR}&to=${now}`)
    ).json()) as StateTimelineDto;

    expect(body.spans.map((s) => s.state)).toEqual(["online", "driving"]);
    expect(body.current?.state).toBe("driving");
  });

  it("requires a car id", async () => {
    const cookie = await login();
    expect((await authed(cookie, "/api/v1/stats/states")).status).toBe(400);
  });
});

describe("charge level history", () => {
  beforeEach(reset);

  const HOUR = 3_600_000;

  async function addSample(at: number, level: number, usable = level) {
    await env.DB.prepare(
      "INSERT INTO positions (car_id, date_at, battery_level, usable_battery_level) VALUES (?, ?, ?, ?)",
    )
      .bind(CAR_ID, at, level, usable)
      .run();
  }

  it("averages samples into buckets and reports the extremes", async () => {
    const cookie = await login();
    const day = berlin(2026, 6, 10, 0);
    // Two samples an hour apart in the same 3-hour bucket, then one much later.
    await addSample(day + 10 * 60_000, 90);
    await addSample(day + 70 * 60_000, 80);
    await addSample(day + 20 * HOUR, 40);

    const body = (await (
      await authed(cookie, `/api/v1/stats/charge-level?carId=${CAR_ID}&from=${day}&to=${day + 24 * HOUR}&points=10`)
    ).json()) as ChargeLevelDto;

    expect(body.bucketMs).toBe(3 * HOUR);
    expect(body.points).toHaveLength(2);
    expect(body.points[0]!.batteryLevel).toBeCloseTo(85, 5);
    expect(body.points[1]!.batteryLevel).toBeCloseTo(40, 5);
    expect(body.minLevel).toBe(40);
    expect(body.maxLevel).toBe(90);
    expect(body.averageLevel).toBeCloseTo(70, 5);
  });

  it("narrows the bucket when more points are asked for", async () => {
    const cookie = await login();
    const day = berlin(2026, 6, 10, 0);
    const wide = (await (
      await authed(cookie, `/api/v1/stats/charge-level?carId=${CAR_ID}&from=${day}&to=${day + 24 * HOUR}&points=10`)
    ).json()) as ChargeLevelDto;
    const narrow = (await (
      await authed(cookie, `/api/v1/stats/charge-level?carId=${CAR_ID}&from=${day}&to=${day + 24 * HOUR}&points=100`)
    ).json()) as ChargeLevelDto;
    expect(narrow.bucketMs).toBeLessThan(wide.bucketMs);
  });

  it("reports the share of sampled buckets sitting at a high state of charge", async () => {
    const cookie = await login();
    const day = berlin(2026, 6, 10, 0);
    // Three buckets: two at 90%, one at 50%.
    await addSample(day + 60_000, 90);
    await addSample(day + 4 * HOUR, 90);
    await addSample(day + 8 * HOUR, 50);

    const body = (await (
      await authed(cookie, `/api/v1/stats/charge-level?carId=${CAR_ID}&from=${day}&to=${day + 24 * HOUR}&points=10`)
    ).json()) as ChargeLevelDto;
    expect(body.highSocThreshold).toBe(80);
    expect(body.highSocShare).toBeCloseTo(2 / 3, 5);
  });

  it("honours a custom high-SoC threshold", async () => {
    const cookie = await login();
    const day = berlin(2026, 6, 10, 0);
    await addSample(day + 60_000, 60);

    const body = (await (
      await authed(cookie, `/api/v1/stats/charge-level?carId=${CAR_ID}&from=${day}&to=${day + 24 * HOUR}&highSoc=50`)
    ).json()) as ChargeLevelDto;
    expect(body.highSocShare).toBe(1);
  });

  it("returns an empty series rather than failing when nothing is logged", async () => {
    const cookie = await login();
    const day = berlin(2026, 6, 10, 0);
    const body = (await (
      await authed(cookie, `/api/v1/stats/charge-level?carId=${CAR_ID}&from=${day}&to=${day + 24 * HOUR}`)
    ).json()) as ChargeLevelDto;
    expect(body.points).toEqual([]);
    expect(body.minLevel).toBeNull();
    expect(body.highSocShare).toBeNull();
  });

  it("requires a car id and rejects a nonsense point count", async () => {
    const cookie = await login();
    expect((await authed(cookie, "/api/v1/stats/charge-level")).status).toBe(400);
    expect((await authed(cookie, `/api/v1/stats/charge-level?carId=${CAR_ID}&points=999999`)).status).toBe(400);
  });
});

describe("update history", () => {
  beforeEach(reset);

  it("lists updates newest first with the gap between them", async () => {
    const cookie = await login();
    const first = berlin(2026, 5, 1);
    const second = berlin(2026, 6, 1);
    await env.DB.prepare(
      "INSERT INTO updates (car_id, start_date_at, end_date_at, version) VALUES (?, ?, ?, '2026.12.1')",
    )
      .bind(CAR_ID, first, first + 600_000)
      .run();
    await env.DB.prepare(
      "INSERT INTO updates (car_id, start_date_at, end_date_at, version) VALUES (?, ?, ?, '2026.14.3')",
    )
      .bind(CAR_ID, second, second + 600_000)
      .run();

    const body = (await (await authed(cookie, `/api/v1/stats/updates?carId=${CAR_ID}`)).json()) as UpdateDto[];
    expect(body).toHaveLength(2);
    expect(body[0]!.version).toBe("2026.14.3");
    expect(body[0]!.daysSincePrevious).toBeCloseTo(31, 0);
    expect(body[1]!.daysSincePrevious).toBeNull();
  });
});

describe("efficiency versus temperature", () => {
  beforeEach(reset);

  const day = berlin(2026, 1, 10, 8);
  const window = `from=${berlin(2026, 1, 1, 0)}&to=${berlin(2026, 2, 1, 0)}`;

  /** A drive at a given outside temperature, using a given amount of range. */
  async function driveAt(at: number, temp: number, distanceKm: number, rangeUsedKm: number) {
    const id = await addDrive(at, distanceKm, rangeUsedKm);
    await env.DB.prepare("UPDATE drives SET outside_temp_avg = ? WHERE id = ?").bind(temp, id).run();
    return id;
  }

  async function fetchEfficiency(cookie: string): Promise<EfficiencyStatsDto> {
    const res = await authed(cookie, `/api/v1/stats/efficiency?carId=${CAR_ID}&${window}`);
    expect(res.status).toBe(200);
    return (await res.json()) as EfficiencyStatsDto;
  }

  it("bands drives below freezing downwards, not towards zero", async () => {
    const cookie = await login();
    // -3 °C belongs in the -5 band. Integer division would truncate it to 0 and
    // average a frozen morning in with a mild one, which is the whole comparison.
    await driveAt(day, -3, 100, 25);
    await driveAt(day + 86_400_000, 18, 100, 15);

    const body = await fetchEfficiency(cookie);

    expect(body.bands.map((band) => band.fromCelsius)).toEqual([-5, 15]);
    // 25 km of range at 0.15 kWh/km over 100 km = 3.75 kWh/100 km.
    expect(body.bands[0]!.consumptionKwhPer100km).toBeCloseTo(3.75, 5);
    expect(body.bands[1]!.consumptionKwhPer100km).toBeCloseTo(2.25, 5);
    // The cold band is the thirstier one, which is the point of the panel.
    expect(body.bands[0]!.consumptionKwhPer100km!).toBeGreaterThan(body.bands[1]!.consumptionKwhPer100km!);
  });

  it("puts an exact band boundary in the band it starts", async () => {
    const cookie = await login();
    await driveAt(day, -5, 50, 10);
    await driveAt(day + 86_400_000, 0, 50, 10);

    const body = await fetchEfficiency(cookie);
    expect(body.bands.map((band) => band.fromCelsius)).toEqual([-5, 0]);
  });

  it("reports gross above net, with the difference as charging loss", async () => {
    const cookie = await login();
    await driveAt(day, 10, 200, 30);
    // 40 kWh reached the pack, 44 came out of the wall: a 9 % loss.
    await env.DB.prepare(
      "INSERT INTO charging_processes (car_id, start_date_at, end_date_at, charge_energy_added, " +
        "charge_energy_used, duration_min, start_battery_level, end_battery_level, " +
        "start_rated_range_km, end_rated_range_km) VALUES (?, ?, ?, 40, 44, 60, 30, 80, 100, 280)",
    )
      .bind(CAR_ID, day, day + 3_600_000)
      .run();

    const body = await fetchEfficiency(cookie);

    // 30 km of range at 0.15 = 4.5 kWh over 200 km = 2.25 kWh/100 km net.
    expect(body.netKwhPer100km).toBeCloseTo(2.25, 5);
    // 44 kWh from the wall over 200 km = 22 kWh/100 km gross.
    expect(body.grossKwhPer100km).toBeCloseTo(22, 5);
    expect(body.grossKwhPer100km!).toBeGreaterThan(body.netKwhPer100km!);
    expect(body.chargingLossShare).toBeCloseTo(1 - 40 / 44, 5);
  });

  it("leaves out drives with no temperature reading", async () => {
    const cookie = await login();
    await addDrive(day, 100);
    const body = await fetchEfficiency(cookie);
    expect(body.bands).toEqual([]);
    // The overall figures still count the drive.
    expect(body.distanceKm).toBeCloseTo(100, 5);
  });
});

describe("odometer over time", () => {
  beforeEach(reset);

  const HOUR = 3_600_000;
  const day = berlin(2026, 6, 10, 0);

  async function addSample(at: number, odometer: number) {
    await env.DB.prepare("INSERT INTO positions (car_id, date_at, odometer) VALUES (?, ?, ?)")
      .bind(CAR_ID, at, odometer)
      .run();
  }

  it("reports the highest reading in each bucket, since an odometer only goes up", async () => {
    const cookie = await login();
    // Two readings a minute apart, so they share a bucket whatever it is aligned to,
    // and one several hours later that cannot.
    await addSample(day + HOUR, 1000);
    await addSample(day + HOUR + 60_000, 1050);
    await addSample(day + 5 * HOUR, 1200);

    const body = (await (
      await authed(cookie, `/api/v1/stats/odometer?carId=${CAR_ID}&from=${day}&to=${day + 6 * HOUR}&points=10`)
    ).json()) as OdometerSeriesDto;

    // Six hours at ten points is an hour a bucket.
    expect(body.bucketMs).toBe(HOUR);
    expect(body.points).toHaveLength(2);
    // The pair collapses to the higher reading, not to their mean of 1025.
    expect(body.points[0]!.odometerKm).toBe(1050);
    expect(body.points[1]!.odometerKm).toBe(1200);
    expect(body.points[0]!.at).toBeLessThan(body.points[1]!.at);
  });

  it("requires a car, because two cars have two odometers", async () => {
    const cookie = await login();
    expect((await authed(cookie, "/api/v1/stats/odometer")).status).toBe(400);
  });
});

describe("place roll-up", () => {
  beforeEach(reset);

  const DAY = 86_400_000;
  const day = berlin(2026, 6, 1, 8);

  let nextAddress = 100;
  async function addAddress(fields: {
    road?: string;
    name?: string;
    city?: string;
    state?: string;
    country?: string;
    raw?: string;
  }) {
    const id = nextAddress++;
    await env.DB.prepare(
      "INSERT INTO addresses (id, display_name, name, road, city, state, country, latitude, longitude, raw, " +
        "inserted_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 52.5, 13.4, ?, ?, ?)",
    )
      .bind(
        id,
        `${fields.road ?? "Somewhere"}, ${fields.city ?? "Nowhere"}`,
        fields.name ?? null,
        fields.road ?? null,
        fields.city ?? null,
        fields.state ?? null,
        fields.country ?? null,
        fields.raw ?? null,
        day,
        day,
      )
      .run();
    return id;
  }

  /** A drive that ended at an address, which is what counts as a visit. */
  async function arriveAt(addressId: number, at: number, geofenceId: number | null = null) {
    const id = await addDrive(at, 10);
    await env.DB.prepare("UPDATE drives SET end_address_id = ?, end_geofence_id = ? WHERE id = ?")
      .bind(addressId, geofenceId, id)
      .run();
    return id;
  }

  async function addGeofence(name: string): Promise<number> {
    const row = await env.DB.prepare(
      "INSERT INTO geofences (name, latitude, longitude, radius, inserted_at, updated_at) " +
        "VALUES (?, 52.5, 13.4, 60, ?, ?) RETURNING id",
    )
      .bind(name, day, day)
      .first<{ id: number }>();
    return row!.id;
  }

  it("counts the distinct places arrived at, and ranks the cities", async () => {
    const cookie = await login();
    const berlinHome = await addAddress({ road: "Musterstraße", city: "Berlin", state: "Berlin", country: "Germany" });
    const berlinOffice = await addAddress({ road: "Bürostraße", city: "Berlin", state: "Berlin", country: "Germany" });
    const leipzig = await addAddress({ road: "Marktplatz", city: "Leipzig", state: "Saxony", country: "Germany" });

    await arriveAt(berlinHome, day);
    await arriveAt(berlinHome, day + DAY);
    await arriveAt(berlinOffice, day + 2 * DAY);
    await arriveAt(leipzig, day + 3 * DAY);

    const body = (await (await authed(cookie, `/api/v1/stats/places?carId=${CAR_ID}`)).json()) as PlaceStatsDto;

    expect(body.counts).toEqual({ addresses: 3, cities: 2, states: 2, countries: 1 });
    // Berlin three arrivals across two addresses, Leipzig one.
    expect(body.topCities).toEqual([
      { label: "Berlin", visits: 3, lastAt: expect.any(Number), geofences: [] },
      { label: "Leipzig", visits: 1, lastAt: expect.any(Number), geofences: [] },
    ]);
    expect(body.topCountries[0]).toMatchObject({ label: "Germany", visits: 4 });
  });

  it("ranks the most-visited places with what an add button needs", async () => {
    const cookie = await login();
    const often = await addAddress({ road: "Stammplatz", city: "Berlin" });
    const once = await addAddress({ road: "Einmalweg", city: "Berlin" });
    await arriveAt(often, day);
    await arriveAt(often, day + DAY);
    await arriveAt(once, day + 2 * DAY);

    const body = (await (await authed(cookie, `/api/v1/stats/places?carId=${CAR_ID}`)).json()) as PlaceStatsDto;

    expect(body.topPlaces.map((p) => p.label)).toEqual(["Stammplatz", "Einmalweg"]);
    // The coordinates are what the pre-filled geo-fence form is seeded from.
    expect(body.topPlaces[0]).toMatchObject({ visits: 2, latitude: 52.5, longitude: 13.4, geofence: null });
  });

  it("returns only as many top places as the limit asks for", async () => {
    const cookie = await login();
    for (let i = 0; i < 3; i++) {
      const address = await addAddress({ road: `Straße ${i}`, city: "Berlin" });
      await arriveAt(address, day + i * DAY);
    }

    const body = (await (await authed(cookie, `/api/v1/stats/places?carId=${CAR_ID}&limit=2`)).json()) as PlaceStatsDto;

    expect(body.topPlaces).toHaveLength(2);
    // The full count still comes back, which is how "Load more" knows to offer.
    expect(body.counts.addresses).toBe(3);
  });

  it("rejects a limit that is not a positive number", async () => {
    const cookie = await login();
    expect((await authed(cookie, `/api/v1/stats/places?carId=${CAR_ID}&limit=abc`)).status).toBe(400);
    expect((await authed(cookie, `/api/v1/stats/places?carId=${CAR_ID}&limit=0`)).status).toBe(400);
  });

  it("labels places and cities with the geo-fence the arrivals matched", async () => {
    const cookie = await login();
    const home = await addAddress({ road: "Musterstraße", city: "Berlin" });
    const elsewhere = await addAddress({ road: "Anderswo", city: "Berlin" });
    const fence = await addGeofence("Home");
    await arriveAt(home, day, fence);
    await arriveAt(elsewhere, day + DAY);

    const body = (await (await authed(cookie, `/api/v1/stats/places?carId=${CAR_ID}`)).json()) as PlaceStatsDto;

    expect(body.topPlaces.find((p) => p.label === "Musterstraße")?.geofence).toBe("Home");
    expect(body.topPlaces.find((p) => p.label === "Anderswo")?.geofence).toBeNull();
    expect(body.recent.find((p) => p.label === "Musterstraße")?.geofence).toBe("Home");
    expect(body.topCities[0]).toMatchObject({ label: "Berlin", geofences: ["Home"] });
  });

  it("guesses what a place is from the OSM tags the geocoder stored", async () => {
    const cookie = await login();
    const school = await addAddress({
      road: "Schulstraße",
      name: "Gymnasium Tiergarten",
      city: "Berlin",
      raw: JSON.stringify({ category: "amenity", type: "school" }),
    });
    const road = await addAddress({ road: "Irgendwo", city: "Berlin" });
    await arriveAt(school, day);
    await arriveAt(road, day + DAY);

    const body = (await (await authed(cookie, `/api/v1/stats/places?carId=${CAR_ID}`)).json()) as PlaceStatsDto;

    const guessed = body.topPlaces.find((p) => p.label === "Schulstraße");
    expect(guessed).toMatchObject({ category: "school", name: "Gymnasium Tiergarten" });
  });

  it("calls the dominant untagged place home, and a rare one nothing", async () => {
    const cookie = await login();
    const home = await addAddress({ road: "Heimweg", city: "Berlin" });
    const other = await addAddress({ road: "Anderswo", city: "Berlin" });
    // Six of eight arrivals at one untagged address: enough history, enough share.
    for (let i = 0; i < 6; i++) await arriveAt(home, day + i * DAY);
    await arriveAt(other, day + 6 * DAY);
    await arriveAt(other, day + 7 * DAY);

    const body = (await (await authed(cookie, `/api/v1/stats/places?carId=${CAR_ID}`)).json()) as PlaceStatsDto;

    expect(body.topPlaces[0]).toMatchObject({ label: "Heimweg", category: "home" });
    // The runner-up gets no guess: not rank one, no tags.
    expect(body.topPlaces[1]).toMatchObject({ label: "Anderswo", category: null });
  });

  it("does not call a place home on thin history", async () => {
    const cookie = await login();
    const somewhere = await addAddress({ road: "Kurzbesuch", city: "Berlin" });
    await arriveAt(somewhere, day);
    await arriveAt(somewhere, day + DAY);

    const body = (await (await authed(cookie, `/api/v1/stats/places?carId=${CAR_ID}`)).json()) as PlaceStatsDto;

    // Rank one and 100% of arrivals, but two visits prove nothing.
    expect(body.topPlaces[0]!.category).toBeNull();
  });

  it("lists where the car has been lately, most recent first", async () => {
    const cookie = await login();
    const old = await addAddress({ road: "Alte Straße", city: "Berlin" });
    const fresh = await addAddress({ road: "Neue Straße", city: "Berlin" });
    await arriveAt(old, day);
    await arriveAt(fresh, day + 5 * DAY);

    const body = (await (await authed(cookie, `/api/v1/stats/places?carId=${CAR_ID}`)).json()) as PlaceStatsDto;

    expect(body.recent.map((place) => place.label)).toEqual(["Neue Straße", "Alte Straße"]);
    expect(body.recent[0]!.city).toBe("Berlin");
  });

  it("counts arrivals, not every address the geocoder has ever seen", async () => {
    const cookie = await login();
    const arrived = await addAddress({ road: "Ziel", city: "Berlin", country: "Germany" });
    // Geocoded but never arrived at — a place passed through on the way somewhere.
    await addAddress({ road: "Durchfahrt", city: "Potsdam", country: "Germany" });
    await arriveAt(arrived, day);

    const body = (await (await authed(cookie, `/api/v1/stats/places?carId=${CAR_ID}`)).json()) as PlaceStatsDto;

    expect(body.counts.addresses).toBe(1);
    expect(body.counts.cities).toBe(1);
    expect(body.topCities.map((city) => city.label)).toEqual(["Berlin"]);
  });

  it("leaves a blank or missing column out of the rankings", async () => {
    const cookie = await login();
    const nameless = await addAddress({ road: "Feldweg" });
    await arriveAt(nameless, day);

    const body = (await (await authed(cookie, `/api/v1/stats/places?carId=${CAR_ID}`)).json()) as PlaceStatsDto;

    // The arrival still counts as an address; it just has no city to rank.
    expect(body.counts.addresses).toBe(1);
    expect(body.topCities).toEqual([]);
    expect(body.recent).toHaveLength(1);
  });

  it("rejects a car id that is not a number", async () => {
    const cookie = await login();
    expect((await authed(cookie, "/api/v1/stats/places?carId=abc")).status).toBe(400);
  });
});

describe("drive aggregates", () => {
  beforeEach(reset);

  const DAY = 86_400_000;
  const day = berlin(2026, 6, 1, 8);
  const window = `from=${day - DAY}&to=${day + 40 * DAY}`;

  async function fetchStats(cookie: string, extra = ""): Promise<DriveStatsDto> {
    const res = await authed(cookie, `/api/v1/stats/drives?carId=${CAR_ID}&${window}${extra}`);
    expect(res.status).toBe(200);
    return (await res.json()) as DriveStatsDto;
  }

  it("reports the middle drive rather than the mean", async () => {
    const cookie = await login();
    // 2, 4, 100: a mean of 35 that describes none of them, a median of 4 that does.
    await addDrive(day, 2);
    await addDrive(day + DAY, 4);
    await addDrive(day + 2 * DAY, 100);

    const body = await fetchStats(cookie);
    expect(body.count).toBe(3);
    expect(body.distanceKm).toBe(106);
    expect(body.medianDistanceKm).toBe(4);
  });

  it("extrapolates from the span the drives cover, not the window asked for", async () => {
    const cookie = await login();
    // 100 km over ten days, inside a window forty days wide.
    await addDrive(day, 50);
    await addDrive(day + 10 * DAY, 50);

    const body = await fetchStats(cookie);
    expect(body.observedDays).toBeCloseTo(10, 1);
    expect(body.distancePerDayKm).toBeCloseTo(10, 1);
    // Dividing by the forty-day window instead would have said 2.5 km/day, and an
    // annual figure under a thousand.
    expect(body.projectedAnnualKm).toBeGreaterThan(3600);
    expect(body.projectedAnnualKm! / body.distancePerDayKm!).toBeCloseTo(365.25, 2);
    expect(body.projectedMonthlyKm! / body.distancePerDayKm!).toBeCloseTo(30.44, 2);
  });

  it("refuses to extrapolate from a single day", async () => {
    const cookie = await login();
    await addDrive(day, 40);

    const body = await fetchStats(cookie);
    expect(body.count).toBe(1);
    expect(body.observedDays).toBeNull();
    expect(body.distancePerDayKm).toBeNull();
    expect(body.projectedAnnualKm).toBeNull();
    // The figures that do not depend on a rate are still reported.
    expect(body.medianDistanceKm).toBe(40);
  });

  it("bands the speed samples and reports the fastest drive", async () => {
    const cookie = await login();
    const drive = await addDrive(day, 20);
    // addDrive writes three samples with no speed; these are the moving ones.
    for (const [i, speed] of [5, 25, 45, 47].entries()) {
      await env.DB.prepare(
        "INSERT INTO positions (car_id, drive_id, date_at, latitude, longitude, speed) VALUES (?, ?, ?, 52.5, 13.4, ?)",
      )
        .bind(CAR_ID, drive, day + i * 1000, speed)
        .run();
    }

    const body = await fetchStats(cookie);
    expect(body.speedBands).toEqual([
      { fromKmh: 0, count: 1 },
      { fromKmh: 20, count: 1 },
      { fromKmh: 40, count: 2 },
    ]);
    // speed_max on the drive row, which addDrive sets to 120.
    expect(body.maxSpeedKmh).toBe(120);
  });

  it("ranks the places drives ended at", async () => {
    const cookie = await login();
    const home = await env.DB.prepare(
      "INSERT INTO geofences (name, latitude, longitude, radius, inserted_at, updated_at) " +
        "VALUES ('Home', 52.5, 13.4, 100, ?, ?) RETURNING id",
    )
      .bind(day, day)
      .first<{ id: number }>();
    const office = await env.DB.prepare(
      "INSERT INTO geofences (name, latitude, longitude, radius, inserted_at, updated_at) " +
        "VALUES ('Office', 52.6, 13.5, 100, ?, ?) RETURNING id",
    )
      .bind(day, day)
      .first<{ id: number }>();

    for (let i = 0; i < 3; i++) {
      const id = await addDrive(day + i * DAY, 10);
      await env.DB.prepare("UPDATE drives SET end_geofence_id = ? WHERE id = ?").bind(home!.id, id).run();
    }
    const once = await addDrive(day + 5 * DAY, 30);
    await env.DB.prepare("UPDATE drives SET end_geofence_id = ? WHERE id = ?").bind(office!.id, once).run();

    const body = await fetchStats(cookie);
    expect(body.topDestinations).toEqual([
      { label: "Home", region: null, count: 3, distanceKm: 30 },
      { label: "Office", region: null, count: 1, distanceKm: 30 },
    ]);
  });

  it("has nothing to say about a window with no drives", async () => {
    const cookie = await login();
    const body = await fetchStats(cookie);
    expect(body.count).toBe(0);
    expect(body.medianDistanceKm).toBeNull();
    expect(body.distancePerDayKm).toBeNull();
    expect(body.speedBands).toEqual([]);
    expect(body.topDestinations).toEqual([]);
  });
});

describe("timeline event log", () => {
  beforeEach(reset);

  const HOUR = 3_600_000;
  const day = berlin(2026, 6, 10, 0);
  const window = `from=${day}&to=${day + 24 * HOUR}`;

  async function addState(state: string, from: number, to: number | null) {
    await env.DB.prepare("INSERT INTO states (car_id, state, start_date_at, end_date_at) VALUES (?, ?, ?, ?)")
      .bind(CAR_ID, state, from, to)
      .run();
  }

  async function addUpdate(at: number, version: string) {
    await env.DB.prepare("INSERT INTO updates (car_id, start_date_at, end_date_at, version) VALUES (?, ?, ?, ?)")
      .bind(CAR_ID, at, at + 20 * 60_000, version)
      .run();
  }

  /** One of each kind, spread across a single day. */
  async function seedOneOfEach() {
    await addState("asleep", day + HOUR, day + 5 * HOUR);
    await addState("offline", day + 6 * HOUR, day + 7 * HOUR);
    await addDrive(day + 8 * HOUR, 42);
    await addCharge(day + 10 * HOUR, 30, 1250);
    await addUpdate(day + 14 * HOUR, "2026.20.1");
  }

  async function fetchPage(cookie: string, extra = ""): Promise<TimelineDto> {
    const res = await authed(cookie, `/api/v1/stats/timeline?carId=${CAR_ID}&${window}${extra}`);
    expect(res.status).toBe(200);
    return (await res.json()) as TimelineDto;
  }

  it("merges drives, charges, sleep, offline and updates into one newest-first list", async () => {
    const cookie = await login();
    await seedOneOfEach();

    const body = await fetchPage(cookie);

    expect(body.events.map((e) => e.kind)).toEqual(["update", "charge", "drive", "offline", "sleep"]);
    expect(body.nextCursor).toBeNull();

    const drive = body.events.find((e) => e.kind === "drive")!;
    expect(drive.distanceKm).toBe(42);
    expect(drive.durationMin).toBe(30);
    // Range delta times the car's efficiency, as on the drives list.
    expect(drive.energyKwh).toBeCloseTo(10 * 0.15, 5);

    const charge = body.events.find((e) => e.kind === "charge")!;
    expect(charge.energyKwh).toBe(30);
    expect(charge.costCents).toBe(1250);
    expect(charge.startBatteryLevel).toBe(30);
    expect(charge.endBatteryLevel).toBe(80);

    // A sleep span has a duration and nothing else to report.
    const sleep = body.events.find((e) => e.kind === "sleep")!;
    expect(sleep.durationMin).toBe(240);
    expect(sleep.distanceKm).toBeNull();
    expect(sleep.label).toBeNull();

    expect(body.events.find((e) => e.kind === "update")!.label).toBe("2026.20.1");
  });

  it("pages through the window without repeating or skipping an event", async () => {
    const cookie = await login();
    await seedOneOfEach();

    const whole = await fetchPage(cookie);
    const key = (event: TimelineDto["events"][number]) => `${event.kind}:${event.id}`;

    const paged: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const body: TimelineDto = await fetchPage(cookie, `&limit=2${cursor ? `&cursor=${cursor}` : ""}`);
      expect(body.events.length).toBeLessThanOrEqual(2);
      paged.push(...body.events.map(key));
      cursor = body.nextCursor;
      if (cursor === null) break;
    }

    expect(cursor).toBeNull();
    expect(paged).toEqual(whole.events.map(key));
  });

  it("separates events that start in the same millisecond", async () => {
    const cookie = await login();
    // A drive and a charge sharing an instant: without a tiebreak in the sort, a
    // cursor cannot tell which of the two it already returned.
    await addDrive(day + 8 * HOUR, 10);
    await addCharge(day + 8 * HOUR, 5, 100);

    const first = await fetchPage(cookie, "&limit=1");
    expect(first.events).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();

    const second = await fetchPage(cookie, `&limit=1&cursor=${first.nextCursor}`);
    expect(second.events).toHaveLength(1);
    expect(second.events[0]!.kind).not.toBe(first.events[0]!.kind);
  });

  it("narrows to the requested kinds", async () => {
    const cookie = await login();
    await seedOneOfEach();

    const body = await fetchPage(cookie, "&kinds=drive,charge");
    expect(body.events.map((e) => e.kind)).toEqual(["charge", "drive"]);
  });

  it("searches places, and leaves out the spans that have no place", async () => {
    const cookie = await login();
    await seedOneOfEach();
    const address = await env.DB.prepare(
      "INSERT INTO addresses (display_name, name, city, latitude, longitude, inserted_at, updated_at) " +
        "VALUES (?, ?, ?, 52.5, 13.4, ?, ?) RETURNING id",
    )
      .bind("Musterstraße 1, Berlin", "Musterstraße", "Berlin", day, day)
      .first<{ id: number }>();
    await env.DB.prepare("UPDATE charging_processes SET address_id = ? WHERE car_id = ?")
      .bind(address!.id, CAR_ID)
      .run();

    const hit = await fetchPage(cookie, "&search=Berlin");
    expect(hit.events.map((e) => e.kind)).toEqual(["charge"]);

    // Sleep and offline carry no text, so they are absent rather than unfiltered.
    const miss = await fetchPage(cookie, "&search=nowhere");
    expect(miss.events).toHaveLength(0);
  });

  it("includes what is still going on, with no end", async () => {
    const cookie = await login();
    const now = Date.now();
    await addState("asleep", now - 2 * HOUR, null);
    await env.DB.prepare("INSERT INTO drives (car_id, start_date_at) VALUES (?, ?)")
      .bind(CAR_ID, now - HOUR)
      .run();

    // Default window, which is the last seven days.
    const body = (await (await authed(cookie, `/api/v1/stats/timeline?carId=${CAR_ID}`)).json()) as TimelineDto;

    expect(body.events.map((e) => e.kind)).toEqual(["drive", "sleep"]);
    expect(body.events.every((e) => e.endAt === null)).toBe(true);
    expect(body.events.every((e) => e.durationMin === null)).toBe(true);
  });

  it("keeps one car's events out of another's", async () => {
    const cookie = await login();
    await seedOneOfEach();
    await env.DB.prepare("INSERT INTO cars (id, vin, inserted_at, updated_at) VALUES (?, ?, ?, ?)")
      .bind(CAR_ID + 1, "5YJ3E1EAXXX000001", day, day)
      .run();
    await env.DB.prepare("INSERT INTO drives (car_id, start_date_at, end_date_at, distance) VALUES (?, ?, ?, 999)")
      .bind(CAR_ID + 1, day + 9 * HOUR, day + 9.5 * HOUR)
      .run();

    const body = await fetchPage(cookie);
    expect(body.events.every((e) => e.carId === CAR_ID)).toBe(true);
    expect(body.events.some((e) => e.distanceKm === 999)).toBe(false);
  });

  it("rejects a missing car, an unknown kind and a malformed cursor", async () => {
    const cookie = await login();
    expect((await authed(cookie, "/api/v1/stats/timeline")).status).toBe(400);
    expect((await authed(cookie, `/api/v1/stats/timeline?carId=${CAR_ID}&kinds=drive,nonsense`)).status).toBe(400);
    expect((await authed(cookie, `/api/v1/stats/timeline?carId=${CAR_ID}&kinds=`)).status).toBe(400);
    expect((await authed(cookie, `/api/v1/stats/timeline?carId=${CAR_ID}&cursor=not-a-cursor`)).status).toBe(400);
    expect((await authed(cookie, `/api/v1/stats/timeline?carId=${CAR_ID}&limit=0`)).status).toBe(400);
  });
});

describe("data health", () => {
  beforeEach(reset);

  const HOUR = 3_600_000;

  /** An open-ended row, which is what a stopped import or a restart leaves. */
  async function openDrive(at: number): Promise<number> {
    const row = await env.DB.prepare(
      "INSERT INTO drives (car_id, start_date_at, distance) VALUES (?, ?, 12) RETURNING id",
    )
      .bind(CAR_ID, at)
      .first<{ id: number }>();
    return row!.id;
  }

  function fetchHealth(cookie: string, query = ""): Promise<DataHealthDto> {
    return authed(cookie, `/api/v1/data-health${query}`).then(async (res) => {
      expect(res.status).toBe(200);
      return (await res.json()) as DataHealthDto;
    });
  }

  it("counts every exportable table and reports when the car was last heard from", async () => {
    const cookie = await login();
    await addDrive(berlin(2026, 6, 10), 100);
    await addDrive(berlin(2026, 6, 11), 50);
    await addCharge(berlin(2026, 6, 12), 20, 600);

    const body = await fetchHealth(cookie);
    const rows = (table: string) => body.tables.find((t) => t.table === table)?.rows;

    expect(rows("cars")).toBe(1);
    expect(rows("drives")).toBe(2);
    expect(rows("charging_processes")).toBe(1);
    // Three positions per seeded drive, which is also what the export would hand out.
    expect(rows("positions")).toBe(6);
    expect(body.lastSampleAt).toBe(berlin(2026, 6, 11) + 2 * 60_000);
  });

  it("offers a download for every table it counts", async () => {
    const cookie = await login();
    const body = await fetchHealth(cookie);

    // Asserted, so an empty list cannot make the loop below pass with no checks.
    expect(body.tables).toHaveLength(9);
    for (const { table } of body.tables) {
      expect((await authed(cookie, `/api/v1/export/${table}.csv`)).status).toBe(200);
    }
  });

  it("says nothing is truncated when every session was closed", async () => {
    const cookie = await login();
    await addDrive(berlin(2026, 6, 10), 100);
    await addCharge(berlin(2026, 6, 11), 20, 600);

    const body = await fetchHealth(cookie);
    expect(body.truncatedCount).toBe(0);
    expect(body.truncated).toEqual([]);
  });

  it("flags an open drive that something newer was logged after", async () => {
    const cookie = await login();
    const abandoned = await openDrive(Date.now() - 2 * HOUR);
    await addDrive(Date.now() - HOUR, 20);

    const body = await fetchHealth(cookie);
    expect(body.truncatedCount).toBe(1);
    expect(body.truncated[0]).toMatchObject({ kind: "drive", id: abandoned, last: false });
  });

  it("flags an open drive with nothing after it once it is too old to be happening", async () => {
    const cookie = await login();
    const stale = await openDrive(Date.now() - 40 * HOUR);

    const body = await fetchHealth(cookie);
    expect(body.truncated).toHaveLength(1);
    // Nothing newer exists, so the card can say the logger simply stopped here.
    expect(body.truncated[0]).toMatchObject({ kind: "drive", id: stale, last: true });
  });

  it("leaves a drive that is happening right now alone", async () => {
    const cookie = await login();
    await openDrive(Date.now() - 10 * 60_000);

    expect((await fetchHealth(cookie)).truncatedCount).toBe(0);
  });

  /*
    The open `states` row is how the app records what the car is doing now — the
    logger closes it when the state changes — so age is no evidence at all. A car
    asleep for a fortnight would otherwise be reported as a fault every time.
  */
  it("never calls a long open state span truncated on age alone", async () => {
    const cookie = await login();
    await env.DB.prepare("INSERT INTO states (car_id, state, start_date_at) VALUES (?, 'asleep', ?)")
      .bind(CAR_ID, Date.now() - 20 * 24 * HOUR)
      .run();

    expect((await fetchHealth(cookie)).truncatedCount).toBe(0);
  });

  /*
    Two open state rows cannot exist — `states_one_open_per_car` forbids them — so
    the only shape this branch can ever see is an open span with a *closed* one
    after it, which is what an import replaying over a live gap leaves behind.
  */
  it("does flag a state span a later closed one was written after", async () => {
    const cookie = await login();
    await env.DB.prepare("INSERT INTO states (car_id, state, start_date_at) VALUES (?, 'asleep', ?)")
      .bind(CAR_ID, Date.now() - 5 * HOUR)
      .run();
    await env.DB.prepare("INSERT INTO states (car_id, state, start_date_at, end_date_at) VALUES (?, 'online', ?, ?)")
      .bind(CAR_ID, Date.now() - HOUR, Date.now())
      .run();

    const body = await fetchHealth(cookie);
    expect(body.truncated.map((t) => t.label)).toEqual(["asleep"]);
  });

  it("scopes the truncated list to one car when asked", async () => {
    const cookie = await login();
    await openDrive(Date.now() - 40 * HOUR);
    await env.DB.prepare("INSERT INTO cars (id, vin, inserted_at, updated_at) VALUES (?, ?, ?, ?)")
      .bind(CAR_ID + 1, "5YJ3E1EAXXX000002", Date.now(), Date.now())
      .run();
    await env.DB.prepare("INSERT INTO drives (car_id, start_date_at, distance) VALUES (?, ?, 5)")
      .bind(CAR_ID + 1, Date.now() - 40 * HOUR)
      .run();

    expect((await fetchHealth(cookie)).truncatedCount).toBe(2);
    expect((await fetchHealth(cookie, `?carId=${CAR_ID}`)).truncatedCount).toBe(1);
  });

  it("flags a charging session and a firmware install that were never closed", async () => {
    const cookie = await login();
    const stale = Date.now() - 40 * HOUR;
    const cproc = await env.DB.prepare(
      "INSERT INTO charging_processes (car_id, start_date_at) VALUES (?, ?) RETURNING id",
    )
      .bind(CAR_ID, stale)
      .first<{ id: number }>();
    await env.DB.prepare("INSERT INTO updates (car_id, start_date_at, version) VALUES (?, ?, '2026.20.1')")
      .bind(CAR_ID, stale)
      .run();

    const body = await fetchHealth(cookie);
    const kinds = body.truncated.map((row) => row.kind);
    expect(kinds).toContain("charge");
    expect(kinds).toContain("update");
    // The charge arm carries its place through the same joins the charges list uses,
    // and the update arm carries the version.
    expect(body.truncated.find((row) => row.kind === "charge")?.id).toBe(cproc!.id);
    expect(body.truncated.find((row) => row.kind === "update")?.label).toBe("2026.20.1");
  });

  it("caps the list it returns while still counting them all", async () => {
    const cookie = await login();
    for (let i = 0; i < 25; i++) await openDrive(Date.now() - (40 + i) * HOUR);

    const body = await fetchHealth(cookie);
    expect(body.truncatedCount).toBe(25);
    expect(body.truncated).toHaveLength(20);
    // Newest first, so the cap drops the oldest rather than the ones worth seeing.
    expect(body.truncated[0]!.startAt).toBeGreaterThan(body.truncated[19]!.startAt);
  });

  it("rejects a car id that is not a positive number", async () => {
    const cookie = await login();
    expect((await authed(cookie, "/api/v1/data-health?carId=nonsense")).status).toBe(400);
    // An empty value used to coerce to car 0 and report a car that does not exist as
    // having nothing wrong with it.
    expect((await authed(cookie, "/api/v1/data-health?carId=")).status).toBe(400);
    expect((await authed(cookie, "/api/v1/data-health?carId=0")).status).toBe(400);
  });
});

describe("CSV export", () => {
  beforeEach(reset);

  it("exports a table with a header row", async () => {
    const cookie = await login();
    await addDrive(berlin(2026, 6, 10), 100);
    const res = await authed(cookie, "/api/v1/export/drives.csv");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toContain("evbook-drives.csv");
    const csv = await res.text();
    expect(csv.split("\n")[0]).toContain("start_date_at");
    expect(csv.split("\n")).toHaveLength(2);
  });

  it("refuses an unknown table", async () => {
    const cookie = await login();
    expect((await authed(cookie, "/api/v1/export/sqlite_master")).status).toBe(404);
  });
});

describe("tyre pressures", () => {
  beforeEach(reset);

  const HOUR = 3_600_000;

  async function addTyreReading(at: number, rl: number | null, softRl: number | null = 0) {
    await env.DB.prepare(
      "INSERT INTO tyre_readings (car_id, date_at, pressure_fl, pressure_fr, pressure_rl, pressure_rr, " +
        "recommended_front, recommended_rear, soft_warning_fl, soft_warning_fr, soft_warning_rl, soft_warning_rr) " +
        "VALUES (?, ?, 2.9, 2.9, ?, 2.9, 2.9, 3.0, 0, 0, ?, 0)",
    )
      .bind(CAR_ID, at, rl, softRl)
      .run();
  }

  it("returns every bucket of the range, with nulls where nothing was read", async () => {
    const cookie = await login();
    const now = Date.now();
    await addTyreReading(now - 2 * HOUR, 2.8);
    await addTyreReading(now - 1 * HOUR, 2.6);
    await addTyreReading(now - 3 * 24 * HOUR, 2.95);

    const res = await authed(cookie, `/api/v1/stats/tyres?carId=${CAR_ID}&range=7d`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as TyrePressureDto;
    expect(body).toMatchObject({ carId: CAR_ID, range: "7d", bucketMs: 6 * HOUR });
    expect(body.points).toHaveLength(28);
    expect(body.points.every((p, i) => p.at === body.from + i * body.bucketMs)).toBe(true);

    const read = body.points.filter((p) => p.rl != null);
    expect(read.map((p) => p.rl)).toHaveLength(2);
    expect(read.at(-1)!.recommendedRear).toBe(3);
    // A gap is a null, never a zero.
    expect(body.points.filter((p) => p.fl == null).length).toBe(26);
    expect(body.points.some((p) => p.fl === 0)).toBe(false);
  });

  it("reports each tyre's current state against its axle's recommendation", async () => {
    const cookie = await login();
    await addTyreReading(Date.now() - HOUR, 2.6);
    const body = (await (await authed(cookie, `/api/v1/stats/tyres?carId=${CAR_ID}`)).json()) as TyrePressureDto;
    expect(body.range).toBe("30d");
    expect(body.current.tyres).toEqual([
      { corner: "fl", pressureBar: 2.9, recommendedBar: 2.9, status: "ok" },
      { corner: "fr", pressureBar: 2.9, recommendedBar: 2.9, status: "ok" },
      { corner: "rl", pressureBar: 2.6, recommendedBar: 3, status: "low" },
      { corner: "rr", pressureBar: 2.9, recommendedBar: 3, status: "ok" },
    ]);
  });

  it("says unknown, not fine, for a car with no readings", async () => {
    const cookie = await login();
    const body = (await (
      await authed(cookie, `/api/v1/stats/tyres?carId=${CAR_ID}&range=12m`)
    ).json()) as TyrePressureDto;
    expect(body.current.at).toBeNull();
    expect(body.current.tyres.map((t) => t.status)).toEqual(["unknown", "unknown", "unknown", "unknown"]);
    expect(body.points).toHaveLength(53);
    expect(body.points.every((p) => p.fl == null && p.recommendedFront == null)).toBe(true);
  });

  it("calls a sensor that went quiet a fault", async () => {
    const cookie = await login();
    await addTyreReading(Date.now() - HOUR, null, null);
    const body = (await (await authed(cookie, `/api/v1/stats/tyres?carId=${CAR_ID}`)).json()) as TyrePressureDto;
    expect(body.current.tyres[2]).toMatchObject({ corner: "rl", pressureBar: null, status: "fault" });
  });

  it("flags the car on the car list when a tyre warns", async () => {
    const cookie = await login();
    const cars = async () => (await (await authed(cookie, "/api/v1/cars")).json()) as CarDto[];
    expect((await cars())[0]!.tyreAttention).toBe(false);
    await addTyreReading(Date.now() - 2 * HOUR, 2.9, 0);
    expect((await cars())[0]!.tyreAttention).toBe(false);
    await addTyreReading(Date.now() - HOUR, 2.85, 1);
    expect((await cars())[0]!.tyreAttention).toBe(true);
  });

  it("rejects a missing car or an unknown range", async () => {
    const cookie = await login();
    expect((await authed(cookie, "/api/v1/stats/tyres")).status).toBe(400);
    expect((await authed(cookie, `/api/v1/stats/tyres?carId=${CAR_ID}&range=5y`)).status).toBe(400);
  });
});
