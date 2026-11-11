import type { CarSummaryDto } from "@shared/api-types";
import type { AppConfig } from "../platform/env";
import type { SqlDatabase } from "../platform/ports";
import { tyreStates, type TyreReadingLike } from "@shared/tyres";
import { latestTyreReading } from "../db/queries/tyres";

/**
 * Demo mode: the app runs against a seeded fixture database with no Tesla
 * account behind it. The flag is a plain env var — `bun run demo` sets it on a
 * local `wrangler dev`, and a showcase deployment can set it as a Worker var.
 *
 * What it changes, all in one place so it can be audited:
 *   - the session reports authenticated + Tesla-signed-in, so the SPA renders
 *     the shell instead of the sign-in and connect screens;
 *   - live summaries are synthesized from the database's latest samples
 *     instead of asking a Vehicle Durable Object that has never polled;
 *   - endpoints that talk to the Tesla API (wake, navigation, discovery,
 *     token sign-in, logging control, imports) answer `demo_mode` instead;
 *   - the cron never wakes a logger.
 *
 * Reads — and writes that only touch the local database, like geofences,
 * charge costs and settings — work as normal: they are the functionality the
 * demo exists to show.
 */
export function isDemo(env: Pick<AppConfig, "DEMO">): boolean {
  return env.DEMO === "true";
}

/** The one answer every Tesla-facing endpoint gives in demo mode. */
export const DEMO_REFUSAL = {
  error: "demo_mode",
  message: "This is a demo with fixture data — there is no real car to talk to.",
} as const;

interface LatestPositionRow {
  car_id: number;
  date_at: number;
  latitude: number | null;
  longitude: number | null;
  odometer: number | null;
  battery_level: number | null;
  usable_battery_level: number | null;
  ideal_battery_range_km: number | null;
  rated_battery_range_km: number | null;
  est_battery_range_km: number | null;
  outside_temp: number | null;
  inside_temp: number | null;
  driver_temp_setting: number | null;
  passenger_temp_setting: number | null;
  is_climate_on: number | null;
  tpms_pressure_fl: number | null;
  tpms_pressure_fr: number | null;
  tpms_pressure_rl: number | null;
  tpms_pressure_rr: number | null;
  state: string | null;
  state_since: number | null;
  version: string | null;
}

/**
 * A live summary read straight off the seeded history: the newest position
 * carries the physical readings, the open state row says what the car is
 * doing, and the newest firmware row says what it runs. The DTO's remaining
 * fields describe a parked, locked, healthy car — which is what the demo
 * fixtures leave behind.
 */
function toSummary(row: LatestPositionRow, tyres: { reading: TyreReadingLike } | null): CarSummaryDto {
  const reading = tyres?.reading ?? null;
  return {
    carId: row.car_id,
    state: row.state ?? "asleep",
    since: row.state_since,
    healthy: true,

    batteryLevel: row.battery_level,
    usableBatteryLevel: row.usable_battery_level,
    chargeLimitSoc: 80,
    idealBatteryRangeKm: row.ideal_battery_range_km,
    ratedBatteryRangeKm: row.rated_battery_range_km,
    estBatteryRangeKm: row.est_battery_range_km,

    odometerKm: row.odometer,
    speedKmh: null,
    power: 0,
    shiftState: null,
    latitude: row.latitude,
    longitude: row.longitude,
    heading: null,

    insideTemp: row.inside_temp,
    outsideTemp: row.outside_temp,
    driverTempSetting: row.driver_temp_setting,
    isClimateOn: row.is_climate_on === 1,
    isPreconditioning: false,

    locked: true,
    sentryMode: false,
    isUserPresent: false,
    doorsOpen: false,
    trunkOpen: false,
    windowsOpen: false,

    chargingState: "Disconnected",
    chargerPower: null,
    chargerVoltage: null,
    chargerCurrent: null,
    chargerPhases: null,
    chargeEnergyAdded: null,
    timeToFullCharge: null,
    chargePortDoorOpen: false,

    version: row.version,
    updateAvailable: false,
    updateVersion: null,

    // The tyre history's newest row, when there is one, is the fuller reading:
    // it carries the warnings and recommended pressures a position does not.
    tpmsPressureFl: reading ? reading.fl : row.tpms_pressure_fl,
    tpmsPressureFr: reading ? reading.fr : row.tpms_pressure_fr,
    tpmsPressureRl: reading ? reading.rl : row.tpms_pressure_rl,
    tpmsPressureRr: reading ? reading.rr : row.tpms_pressure_rr,
    tpmsSoftWarningFl: reading?.softFl ?? null,
    tpmsSoftWarningFr: reading?.softFr ?? null,
    tpmsSoftWarningRl: reading?.softRl ?? null,
    tpmsSoftWarningRr: reading?.softRr ?? null,
    tyres: tyreStates(reading),

    dataAt: row.date_at,

    doorDfOpen: false,
    doorPfOpen: false,
    doorDrOpen: false,
    doorPrOpen: false,
    windowFdOpen: false,
    windowFpOpen: false,
    windowRdOpen: false,
    windowRpOpen: false,

    chargeRateKmh: null,
    connChargeCable: null,
    batteryHeater: false,
    cabinOverheatProtection: null,
    copActivelyCooling: null,
    passengerTempSetting: row.passenger_temp_setting,
    autoSeatClimateLeft: null,
    autoSeatClimateRight: null,
    autoSteeringWheelHeat: null,
    dashcamState: null,
    scheduledChargingPending: null,
    tripCharging: null,

    activeRoute: null,
    sleepBlocker: null,
    lastFetchAt: row.date_at,
    lastError: null,
  };
}

const SUMMARY_SQL =
  "SELECT p.car_id, p.date_at, p.latitude, p.longitude, p.odometer, p.battery_level, p.usable_battery_level, " +
  "p.ideal_battery_range_km, p.rated_battery_range_km, p.est_battery_range_km, p.outside_temp, p.inside_temp, " +
  "p.driver_temp_setting, p.passenger_temp_setting, p.is_climate_on, " +
  "p.tpms_pressure_fl, p.tpms_pressure_fr, p.tpms_pressure_rl, p.tpms_pressure_rr, " +
  "s.state AS state, s.start_date_at AS state_since, " +
  "(SELECT u.version FROM updates u WHERE u.car_id = p.car_id ORDER BY u.start_date_at DESC LIMIT 1) AS version " +
  "FROM positions p " +
  "LEFT JOIN states s ON s.car_id = p.car_id AND s.end_date_at IS NULL " +
  "WHERE p.id = (SELECT p2.id FROM positions p2 WHERE p2.car_id = p.car_id ORDER BY p2.date_at DESC LIMIT 1)";

/** Summaries for every car with any history, in car order. */
export async function demoSummaries(db: SqlDatabase): Promise<CarSummaryDto[]> {
  const rows = await db.prepare(`${SUMMARY_SQL} ORDER BY p.car_id`).all<LatestPositionRow>();
  return Promise.all(rows.results.map(async (row) => toSummary(row, await latestTyreReading(db, row.car_id))));
}

export async function demoSummary(db: SqlDatabase, carId: number): Promise<CarSummaryDto | null> {
  const row = await db.prepare(`${SUMMARY_SQL} AND p.car_id = ?`).bind(carId).first<LatestPositionRow>();
  return row ? toSummary(row, await latestTyreReading(db, carId)) : null;
}
