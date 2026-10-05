import { CsvHeader, bool, num, parseCsv, parseTimestamp, text, toBar, toCelsius, toMiles, toMph } from "../csv";
import { mergeTracks, type MergeTrack, type TimedRow } from "../merge";
import { carTypeFromVin, findVin } from "../../../../shared/vin";
import type { VehicleData } from "../../tesla/payload";
import type { ImportBundle, ImportSnapshot, ImportSourceAdapter, SnapshotOptions, SourceDetection } from "../types";

/**
 * Tessie (https://tessie.com) CSV export — the zip its "Download all data"
 * produces, named after the VIN and holding one file per metric group:
 *
 *   driving_states.csv    GPS, shift state, odometer, speed
 *   charging_states.csv   charging state, SOC, ranges, charger readings
 *   climate_states.csv    climate on, inside and outside temperature
 *   vehicle_states.csv    locked, sentry mode
 *   battery_states.csv    pack energy, current and voltage, module temps
 *   tpms_pressure_*.csv   one file per tyre
 *
 * Every file is `Timestamp (UTC)` plus values, ascending, and the header carries
 * the unit the account was set to — so the columns are read by name and
 * normalised to the units Tesla's own API uses.
 *
 * What the export cannot give us, and what this adapter does instead:
 *
 * | Tesla field | Approach |
 * |---|---|
 * | `charge_energy_added` | Pack energy gained since the session started (`Energy Remaining`). Left at zero when the pack file does not cover the period — the charger's own reading is what `charge_energy_used` already is, and standing in for the pack with it overstates battery health. |
 * | `drive_state.power` | Pack current x pack voltage, negated: Tessie reports current negative while discharging, Tesla reports power positive while consuming. |
 * | `battery_level` | Tessie exports only the usable level; both columns get it. |
 * | `fast_charger_type` | Not exported. Left null, which means Supercharger sessions are not recognised as free even with free supercharging on. AC/DC still splits correctly, on reported phases. |
 * | `est_battery_range` | Not exported; left null. |
 * | software version, elevation | Not exported. No `updates` rows, no elevation. |
 */

const TRACK_FILES = {
  driving: "driving_states.csv",
  charging: "charging_states.csv",
  climate: "climate_states.csv",
  vehicle: "vehicle_states.csv",
  battery: "battery_states.csv",
  tpmsFl: "tpms_pressure_fl.csv",
  tpmsFr: "tpms_pressure_fr.csv",
  tpmsRl: "tpms_pressure_rl.csv",
  tpmsRr: "tpms_pressure_rr.csv",
} as const;

type TrackName = keyof typeof TRACK_FILES;

/**
 * How long a track's last row keeps describing the car. GPS and the odometer
 * still hold while it is parked for days; a charger reading does not.
 */
const MAX_AGE_MIN: Record<TrackName, number> = {
  driving: 7 * 24 * 60,
  charging: 5,
  climate: 30,
  vehicle: 60,
  battery: 10,
  tpmsFl: 30 * 24 * 60,
  tpmsFr: 30 * 24 * 60,
  tpmsRl: 30 * 24 * 60,
  tpmsRr: 30 * 24 * 60,
};

const TIMESTAMP = "timestamp";

/** Charging states that still mean "cable attached", so energy keeps counting. */
const STILL_CONNECTED = new Set(["Charging", "Starting", "Complete", "Stopped", "NoPower"]);

interface DrivingRow {
  latitude: number | null;
  longitude: number | null;
  shift: string | null;
  odometerMi: number | null;
  speedMph: number | null;
}

interface ChargingRow {
  state: string | null;
  level: number | null;
  ratedMi: number | null;
  idealMi: number | null;
  current: number | null;
  phases: number | null;
  power: number | null;
  voltage: number | null;
}

interface ClimateRow {
  climateOn: boolean | null;
  insideC: number | null;
  outsideC: number | null;
}

interface VehicleRow {
  locked: boolean | null;
  sentry: boolean | null;
}

interface BatteryRow {
  energyRemainingKwh: number | null;
  packCurrentA: number | null;
  packVoltageV: number | null;
  tempMinC: number | null;
  tempMaxC: number | null;
}

interface TpmsRow {
  bar: number | null;
}

type Row = DrivingRow | ChargingRow | ClimateRow | VehicleRow | BatteryRow | TpmsRow;

export const tessieSource: ImportSourceAdapter = {
  id: "tessie",
  label: "Tessie",
  describe: "Tessie CSV export (one zip named after the VIN, one file per metric group)",
  howToExport: "Tessie app -> your vehicle -> Settings -> Export -> Download all data; keep the zip as downloaded.",

  async detect(bundle: ImportBundle): Promise<SourceDetection> {
    const entries = await bundle.entries();
    const recognised: string[] = [];
    const missing: string[] = [];
    const notes: string[] = [];

    for (const file of Object.values(TRACK_FILES)) {
      const entry = entries.find((candidate) => candidate.name === file);
      if (!entry) missing.push(file);
      else if (entry.size === 0) notes.push(`${file} is empty`);
      else recognised.push(file);
    }

    // The two files that carry everything drive detection needs.
    const core = [TRACK_FILES.driving, TRACK_FILES.charging].filter((file) => recognised.includes(file));
    let confidence = core.length === 2 ? 0.9 : core.length === 1 ? 0.4 : 0;

    if (confidence > 0) {
      const path = entries.find((entry) => entry.name === TRACK_FILES.charging)?.path;
      const header = path ? await firstLine(bundle, path) : null;
      if (header?.toLowerCase().includes("charging state")) confidence = 1;
      else notes.push(`${TRACK_FILES.charging} has an unexpected header: ${header ?? "(none)"}`);
    }

    const vin = findVin(bundle.label) ?? entries.map((entry) => findVin(entry.path)).find((found) => found) ?? null;
    return { confidence, vin, recognised, missing, notes };
  },

  /**
   * Read from `driving_states.csv` alone: it is the smallest file that still
   * spans the whole export, and only its timestamp column is parsed, so this
   * costs one pass over a few megabytes rather than over the whole export.
   */
  async span(bundle: ImportBundle): Promise<{ firstAt: number; lastAt: number } | null> {
    const entries = await bundle.entries();
    const entry =
      entries.find((candidate) => candidate.name === TRACK_FILES.driving) ??
      entries.find((candidate) => candidate.name === TRACK_FILES.charging);
    if (!entry) return null;

    let firstAt: number | null = null;
    let lastAt: number | null = null;
    let column = -1;
    for await (const fields of parseCsv(bundle.lines(entry.path))) {
      if (column === -1) {
        column = new CsvHeader(fields).index(TIMESTAMP, "date", "time");
        if (column === -1) return null;
        continue;
      }
      const at = parseTimestamp(fields[column]);
      if (at === null) continue;
      firstAt ??= at;
      lastAt = at;
    }
    return firstAt === null || lastAt === null ? null : { firstAt, lastAt };
  },

  async *snapshots(bundle: ImportBundle, options: SnapshotOptions): AsyncIterable<ImportSnapshot> {
    const entries = await bundle.entries();
    const warn = options.warn ?? (() => {});
    const vin = findVin(bundle.label);
    const carType = vin ? carTypeFromVin(vin) : null;

    const tracks: MergeTrack<Row>[] = [];
    const present = new Set<TrackName>();
    for (const [name, file] of Object.entries(TRACK_FILES) as [TrackName, string][]) {
      const entry = entries.find((candidate) => candidate.name === file);
      if (!entry) {
        warn(`${file} is not in the export — the values it carries stay empty`);
        continue;
      }
      present.add(name);
      tracks.push({
        name,
        maxAgeMs: MAX_AGE_MIN[name] * 60_000,
        rows: readTrack(bundle, entry.path, name, warn),
      });
    }
    if (tracks.length === 0) throw new Error("no Tessie CSV files found in the export");
    if (!present.has("battery")) {
      warn(
        "battery_states.csv is missing — charges get the energy the charger delivered but not the energy the pack " +
          "took, so there is nothing to derive battery health from",
      );
    }

    const minIntervalMs = (options.minIntervalS ?? 0) * 1000;
    const since = options.since;
    const until = options.until;

    // Session-relative energy: Tessie exports the pack's absolute energy, Tesla
    // reports how much this session has added. Track the session ourselves,
    // keyed on the same charging states the reducer switches on.
    //
    // Only the pack can answer this. Integrating the charger's power measures
    // what went into the car, which on AC is a sixth more than what reaches the
    // pack — and battery health divides this figure by the state of charge it
    // bought, so a wall-side number there reads as a pack bigger than the one
    // the factory fitted. A session the pack file does not cover stays at 0
    // throughout, which the session total reads as unknown and battery health
    // skips; its energy is still counted from the charger, as
    // `charge_energy_used`, which is what a wall-side reading is.
    let charging = false;
    let baselineKwh: number | null = null;
    /** State of charge the session opened on; see the baseline adoption below. */
    let baselineSoc: number | null = null;
    let sessionAddedKwh = 0;

    let lastEmittedAt = -Infinity;
    let lastShift: string | null = null;
    let lastState: string | null = null;
    /** Tracks that contributed at least one row inside the imported window. */
    const contributed = { driving: false, charging: false, climate: false, vehicle: false, battery: false };
    let firstSampleAt: number | null = null;
    let firstBatteryAt: number | null = null;

    // Everything before the emit gate below runs for every sample in the export,
    // even ones this call will not yield. A Worker import resumes by asking for
    // samples `since` the last one it handled, and a charging session's energy is
    // measured from where that session started — which may be long before the
    // resume point. Skipping the bookkeeping would restart the measurement at
    // every slice boundary and lose most of the energy.
    for await (const sample of mergeTracks(tracks)) {
      const at = sample.at;
      if (until !== undefined && at > until) break;

      const driving = sample.tracks.driving as DrivingRow | null;
      const charge = sample.tracks.charging as ChargingRow | null;
      const climate = sample.tracks.climate as ClimateRow | null;
      const vehicle = sample.tracks.vehicle as VehicleRow | null;
      const battery = sample.tracks.battery as BatteryRow | null;

      // --- charging session bookkeeping ---
      const state = charge?.state ?? null;
      const nowCharging = state === "Charging" || state === "Starting";
      if (nowCharging && !charging) {
        baselineKwh = battery?.energyRemainingKwh ?? null;
        baselineSoc = charge?.level ?? null;
        sessionAddedKwh = 0;
      }
      // Tesla keeps reporting the session's energy until the cable comes out, and
      // the reducer writes one last charge row from the sample that ended the
      // session — so keep counting while the car is still plugged in. A gap in
      // the pack file holds the last figure rather than restating the session
      // against a different measurement.
      if (nowCharging || STILL_CONNECTED.has(state ?? "")) {
        // Tessie writes pack rows only while the car is awake, so a session that
        // wakes the car often runs a minute or two before its first one. Adopt
        // that reading as the baseline while the state of charge is still the one
        // the session opened on: no percent has been bought yet, so the energy
        // missed is energy no derivation here divides by.
        if (baselineKwh === null && battery?.energyRemainingKwh != null && baselineSoc !== null) {
          if (charge?.level === baselineSoc) baselineKwh = battery.energyRemainingKwh;
        }
        if (baselineKwh !== null && battery?.energyRemainingKwh != null) {
          sessionAddedKwh = Math.max(0, battery.energyRemainingKwh - baselineKwh);
        }
      }
      charging = nowCharging;

      const phases = chargerPhases(charge);

      // Never drop a sample that could move the state machine.
      const transition = charge?.state !== lastState || driving?.shift !== lastShift;
      lastState = charge?.state ?? null;
      lastShift = driving?.shift ?? null;

      // --- emit gate ---
      if (since !== undefined && at < since) continue;

      firstSampleAt ??= at;
      if (driving) contributed.driving = true;
      if (charge) contributed.charging = true;
      if (climate) contributed.climate = true;
      if (vehicle) contributed.vehicle = true;
      if (battery) {
        contributed.battery = true;
        firstBatteryAt ??= at;
      }

      if (!transition && minIntervalMs > 0 && at - lastEmittedAt < minIntervalMs) continue;
      lastEmittedAt = at;

      yield {
        at,
        data: {
          id: null,
          vehicle_id: null,
          vin: vin ?? null,
          display_name: options.carName ?? null,
          state: "online",
          drive_state: {
            timestamp: at,
            latitude: driving?.latitude ?? null,
            longitude: driving?.longitude ?? null,
            speed: driving?.speedMph ?? null,
            power: packPowerKw(battery, driving?.speedMph ?? null),
            // Tessie only writes a row when the shift changes or the car moves,
            // so the last one still describes the car: after a drive ends it is
            // the "P" that ended it.
            shift_state: driving?.shift ?? null,
            heading: null,
          },
          charge_state: {
            timestamp: at,
            charging_state: state,
            battery_level: charge?.level ?? null,
            usable_battery_level: charge?.level ?? null,
            battery_range: charge?.ratedMi ?? null,
            est_battery_range: null,
            ideal_battery_range: charge?.idealMi ?? null,
            charge_energy_added: round(sessionAddedKwh, 2),
            charger_actual_current: charge?.current ?? null,
            charger_phases: phases,
            charger_pilot_current: null,
            charger_power: charge?.power ?? null,
            charger_voltage: charge?.voltage ?? null,
            conn_charge_cable: null,
            // No phases means DC, which is also how a fast charger shows up.
            // Brand and type are not exported, so they stay null.
            fast_charger_present: nowCharging ? phases === null && (charge?.power ?? 0) >= 25 : null,
            fast_charger_brand: null,
            fast_charger_type: null,
            not_enough_power_to_heat: null,
            battery_heater_on: null,
            charge_limit_soc: null,
            charge_port_door_open: null,
            time_to_full_charge: null,
            scheduled_charging_start_time: null,
          },
          climate_state: {
            timestamp: at,
            outside_temp: climate?.outsideC ?? null,
            inside_temp: climate?.insideC ?? null,
            is_preconditioning: null,
            climate_keeper_mode: null,
            battery_heater: null,
            battery_heater_no_power: null,
            fan_status: null,
            is_climate_on: climate?.climateOn ?? null,
            driver_temp_setting: null,
            passenger_temp_setting: null,
            is_rear_defroster_on: null,
            is_front_defroster_on: null,
          },
          vehicle_state: {
            timestamp: at,
            odometer: driving?.odometerMi ?? null,
            car_version: null,
            locked: vehicle?.locked ?? null,
            sentry_mode: vehicle?.sentry ?? null,
            is_user_present: null,
            service_mode: null,
            df: null,
            pf: null,
            dr: null,
            pr: null,
            ft: null,
            rt: null,
            fd_window: null,
            fp_window: null,
            rd_window: null,
            rp_window: null,
            tpms_pressure_fl: (sample.tracks.tpmsFl as TpmsRow | null)?.bar ?? null,
            tpms_pressure_fr: (sample.tracks.tpmsFr as TpmsRow | null)?.bar ?? null,
            tpms_pressure_rl: (sample.tracks.tpmsRl as TpmsRow | null)?.bar ?? null,
            tpms_pressure_rr: (sample.tracks.tpmsRr as TpmsRow | null)?.bar ?? null,
            tpms_soft_warning_fl: null,
            tpms_soft_warning_fr: null,
            tpms_soft_warning_rl: null,
            tpms_soft_warning_rr: null,
            software_update: null,
          },
          // The pack file measures the modules, which no Tesla endpoint does.
          // Only carried while there is a reading: a gap in the pack file means
          // the car was asleep, not that the battery had no temperature.
          pack_state:
            battery == null || (battery.tempMinC == null && battery.tempMaxC == null)
              ? null
              : { timestamp: at, temp_min: battery.tempMinC, temp_max: battery.tempMaxC },
          vehicle_config: carType
            ? {
                car_type: carType,
                trim_badging: null,
                exterior_color: null,
                wheel_type: null,
                spoiler_type: null,
                car_special_type: null,
              }
            : null,
        } satisfies VehicleData,
      };
    }

    // A file can exist and still hold nothing for the window being imported —
    // Tessie only started writing pack data partway through, for instance.
    if (present.has("battery") && !contributed.battery) {
      warn(
        "no pack data (battery_states.csv) covers this period — positions get no power reading and charges get no " +
          "pack energy, so nothing here feeds battery health",
      );
    }
    if (firstBatteryAt !== null && firstSampleAt !== null && firstBatteryAt - firstSampleAt > 3_600_000) {
      warn(
        `pack energy (battery_states.csv) only starts ${new Date(firstBatteryAt).toISOString().slice(0, 10)} — charges ` +
          "before that show the energy the charger delivered but none from the pack, so the Health page begins its " +
          "capacity series on that date",
      );
    }
    if (present.has("driving") && !contributed.driving) warn("no GPS or odometer data covers this period");
    if (present.has("climate") && !contributed.climate) warn("no temperature data covers this period");
    if (present.has("vehicle") && !contributed.vehicle) warn("no lock or sentry data covers this period");
    if (present.has("charging") && !contributed.charging) warn("no charger data covers this period");
  },
};

/**
 * Tessie reports pack current negative while the car draws from the battery;
 * Tesla reports power positive while consuming. Rounded to whole kW, like the
 * column it lands in — and so that a parked car's few hundred watts of standby
 * draw does not read as "power is being used" and block sleep.
 *
 * A moving car cannot be drawing exactly nothing, so a pack current of 0 while
 * it rolls is a gap in the export rather than a reading — some periods have the
 * pack columns filled in with zeros. Reporting it as unknown keeps a flat 0 kW
 * line out of the drive charts.
 */
function packPowerKw(battery: BatteryRow | null, speedMph: number | null): number | null {
  if (battery?.packCurrentA == null || battery.packVoltageV == null) return null;
  if (battery.packCurrentA === 0 && (speedMph ?? 0) > 0) return null;
  const kw = Math.round(-(battery.packCurrentA * battery.packVoltageV) / 1000);
  return kw === 0 ? 0 : kw; // negating can leave -0 behind
}

/** Mains voltage never gets this high; a pack being DC-charged always does. */
const AC_MAX_VOLTAGE = 270;

/**
 * Tesla reports `charger_phases` on AC and nothing on DC, and the whole app
 * splits AC from DC on that. Tessie leaves the column empty for some AC
 * sessions too, so when it is missing the voltage decides: mains voltage means
 * AC, and the phase count follows from power = current x voltage x phases.
 */
function chargerPhases(charge: ChargingRow | null): number | null {
  if (charge?.phases != null) return charge.phases;
  const voltage = charge?.voltage ?? null;
  const power = charge?.power ?? 0;
  if (voltage == null || voltage > AC_MAX_VOLTAGE || power <= 0) return null;
  const current = charge?.current ?? 0;
  if (current <= 0) return 1;
  return Math.min(3, Math.max(1, Math.round((power * 1000) / (current * voltage))));
}

/** Reads one CSV into timestamped rows, mapping columns by header name. */
async function* readTrack(
  bundle: ImportBundle,
  path: string,
  track: TrackName,
  warn: (message: string) => void,
): AsyncIterable<TimedRow<Row>> {
  let header: CsvHeader | null = null;
  let build: ((fields: string[]) => Row) | null = null;
  let timestampAt = -1;
  let skipped = 0;
  let rows = 0;

  for await (const fields of parseCsv(bundle.lines(path))) {
    if (header === null) {
      header = new CsvHeader(fields);
      timestampAt = header.index(TIMESTAMP, "date", "time");
      if (timestampAt === -1) {
        warn(`${path}: no timestamp column (${fields.join(", ")}) — file skipped`);
        return;
      }
      build = builderFor(track, header, warn);
      continue;
    }

    const at = parseTimestamp(fields[timestampAt]);
    if (at === null) {
      skipped++;
      continue;
    }
    rows++;
    yield { at, row: build!(fields) };
  }

  if (rows === 0) warn(`${path}: no data rows`);
  if (skipped > 0) warn(`${path}: ${skipped} row(s) with an unreadable timestamp were skipped`);
}

function builderFor(track: TrackName, header: CsvHeader, warn: (message: string) => void): (fields: string[]) => Row {
  switch (track) {
    case "driving": {
      const lat = header.index("latitude");
      const lon = header.index("longitude");
      const shift = header.index("shift state");
      const odo = header.index("odometer");
      const odoUnit = header.unit("odometer");
      const speed = header.index("speed");
      const speedUnit = header.unit("speed");
      reportUnmapped(header, [lat, lon, shift, odo, speed], warn);
      return (fields): DrivingRow => ({
        latitude: num(fields[lat]),
        longitude: num(fields[lon]),
        shift: text(fields[shift]),
        odometerMi: toMiles(num(fields[odo]), odoUnit),
        speedMph: toMph(num(fields[speed]), speedUnit),
      });
    }
    case "charging": {
      const state = header.index("charging state");
      const level = header.index("usable battery level", "battery level");
      const rated = header.index("battery range");
      const ratedUnit = header.unit("battery range");
      const ideal = header.index("ideal battery range");
      const idealUnit = header.unit("ideal battery range");
      const current = header.index("charger current");
      const phases = header.index("charger phases");
      const power = header.index("charger power");
      const voltage = header.index("charger voltage");
      reportUnmapped(header, [state, level, rated, ideal, current, phases, power, voltage], warn);
      return (fields): ChargingRow => ({
        state: text(fields[state]),
        level: num(fields[level]),
        ratedMi: toMiles(num(fields[rated]), ratedUnit),
        idealMi: toMiles(num(fields[ideal]), idealUnit),
        current: num(fields[current]),
        phases: num(fields[phases]),
        power: num(fields[power]),
        voltage: num(fields[voltage]),
      });
    }
    case "climate": {
      const enabled = header.index("climate enabled", "is climate on");
      const inside = header.index("inside temp");
      const insideUnit = header.unit("inside temp");
      const outside = header.index("outside temp");
      const outsideUnit = header.unit("outside temp");
      reportUnmapped(header, [enabled, inside, outside], warn);
      return (fields): ClimateRow => ({
        climateOn: bool(fields[enabled]),
        insideC: toCelsius(num(fields[inside]), insideUnit),
        outsideC: toCelsius(num(fields[outside]), outsideUnit),
      });
    }
    case "vehicle": {
      const locked = header.index("locked");
      const sentry = header.index("sentry mode");
      reportUnmapped(header, [locked, sentry], warn);
      return (fields): VehicleRow => ({ locked: bool(fields[locked]), sentry: bool(fields[sentry]) });
    }
    case "battery": {
      const energy = header.index("energy remaining");
      const current = header.index("pack current");
      const voltage = header.index("pack voltage");
      const tempMin = header.index("min battery module temp");
      const tempMinUnit = header.unit("min battery module temp");
      const tempMax = header.index("max battery module temp");
      const tempMaxUnit = header.unit("max battery module temp");
      reportUnmapped(header, [energy, current, voltage, tempMin, tempMax], warn);
      return (fields): BatteryRow => ({
        energyRemainingKwh: num(fields[energy]),
        packCurrentA: num(fields[current]),
        packVoltageV: num(fields[voltage]),
        tempMinC: toCelsius(num(fields[tempMin]), tempMinUnit),
        tempMaxC: toCelsius(num(fields[tempMax]), tempMaxUnit),
      });
    }
    default: {
      // One column per tyre file, named after the corner.
      const pressure = header.index(
        "front left tire pressure",
        "front right tire pressure",
        "rear left tire pressure",
        "rear right tire pressure",
        "pressure",
      );
      const unit = header.columns[pressure] ? header.unit(header.columns[pressure]!) : null;
      return (fields): TpmsRow => ({ bar: toBar(num(fields[pressure]), unit) });
    }
  }
}

/** Columns present in the export that this adapter has no home for. */
function reportUnmapped(header: CsvHeader, used: number[], warn: (message: string) => void): void {
  const unmapped = header.unmapped([...used, header.index(TIMESTAMP, "date", "time")]);
  if (unmapped.length > 0) warn(`unmapped column(s): ${unmapped.join(", ")}`);
}

async function firstLine(bundle: ImportBundle, path: string): Promise<string | null> {
  for await (const line of bundle.lines(path)) return line;
  return null;
}

function round(value: number, precision: number): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}
