import type { PreferredRange, TripDto, TripLegDto, TripsDto, TripStopDto } from "@shared/api-types";
import { consumptionPer100km } from "../../core/derive/consumption";
import { haversineMeters } from "../../core/geo/geofence";
import {
  detectTrips,
  normalizeTripDrives,
  TRIP_DEFAULTS,
  type TripDrive,
  type TripPlace,
  type TripRun,
} from "../../core/trips";
import {
  END_LABEL as DRIVE_END_LABEL,
  END_REGION as DRIVE_END_REGION,
  JOINS as DRIVE_JOINS,
  START_LABEL as DRIVE_START_LABEL,
  START_REGION as DRIVE_START_REGION,
  energyExpr,
} from "./drives";
import { HAS_ENERGY, JOINS as CHARGE_JOINS, LABEL as CHARGE_LABEL } from "./charges";
import type { SqlDatabase } from "../../platform/ports";

/**
 * The trip roll-up: drives grouped into journeys by [`core/trips`](../../core/trips.ts),
 * then given the charging that happened at their stops.
 *
 * Two reads, whatever the window holds. Everything else is arithmetic on rows the
 * drives list already knows how to fetch — which is why this is mostly composition
 * rather than new SQL, and why the map and the state band on the trip page are the
 * existing `/drives/route` and `/stats/states` endpoints pointed at a trip's span.
 */

export interface TripFilters {
  carId: number;
  from: number;
  to: number;
  preferredRange: PreferredRange;
  now?: number;
}

/**
 * How far either side of the window to read drives.
 *
 * Both edges need it, and for the same reason: a journey the window opens part-way
 * through has to be grouped from its real beginning, and one the window closes
 * part-way through has to be grouped to its real end. Reading only backwards — which
 * this did — returned the outbound half of a trip that crossed the end of a month as
 * a *finished* journey ending at the coast, and the adjacent month returned the whole
 * of it again under the same identity, so paging through a year double-counted the
 * outbound leg. Worse, a trip with one drive before the boundary and two after it
 * fell below the two-drive minimum and was reported as everyday driving.
 *
 * A fortnight, which does not bound a trip: nothing does except the 48-hour rule, and
 * that never fires on a tour that drives every day. A journey longer than this is
 * still cut, and `truncated` says so rather than the page implying otherwise.
 */
const OVERREAD_MS = 14 * 86_400_000;

/**
 * Both identities of a place, kept apart rather than coalesced into one key.
 * The grouping matches on either, because they do not fail together: the same
 * driveway is inside the geofence one day and only an address the next.
 */
function place(geofenceId: number | null, addressId: number | null): TripPlace {
  return {
    geofence: geofenceId == null ? null : `g${geofenceId}`,
    address: addressId == null ? null : `a${addressId}`,
  };
}

interface DriveRow {
  id: number;
  start_at: number;
  end_at: number;
  distance: number | null;
  duration_min: number | null;
  energy_kwh: number | null;
  start_label: string | null;
  end_label: string | null;
  start_region: string | null;
  end_region: string | null;
  start_geofence_id: number | null;
  end_geofence_id: number | null;
  start_address_id: number | null;
  end_address_id: number | null;
  start_battery_level: number | null;
  end_battery_level: number | null;
  start_lat: number | null;
  start_lon: number | null;
  end_lat: number | null;
  end_lon: number | null;
}

interface ChargeRow {
  start_at: number;
  label: string | null;
  energy_kwh: number | null;
  cost_cents: number | null;
  start_battery_level: number | null;
}

function total(values: (number | null)[]): number | null {
  const present = values.filter((value): value is number => value != null);
  return present.length === 0 ? null : present.reduce((sum, value) => sum + value, 0);
}

function lowest(values: (number | null)[]): number | null {
  const present = values.filter((value): value is number => value != null);
  return present.length === 0 ? null : Math.min(...present);
}

/**
 * The stops inside a run: one per gap between consecutive drives, plus the place
 * the car is sitting now if the journey has not finished.
 *
 * Arriving at the end of a closed trip is deliberately not a stop. It would have no
 * leaving time, so any charging after it — every session at home from then on —
 * would be counted as part of the journey.
 */
function stopsOf(run: TripRun, charges: ChargeRow[], now: number): TripStopDto[] {
  const stops: {
    label: string | null;
    region: string | null;
    arrivedAt: number;
    leftAt: number | null;
    batteryLevel: number | null;
  }[] = [];

  for (let i = 0; i < run.drives.length - 1; i++) {
    stops.push({
      label: run.drives[i]!.endLabel,
      region: run.drives[i]!.endRegion,
      arrivedAt: run.drives[i]!.endAt,
      leftAt: run.drives[i + 1]!.startAt,
      batteryLevel: run.drives[i]!.endBatteryLevel,
    });
  }
  if (!run.closed) {
    const last = run.drives[run.drives.length - 1]!;
    stops.push({
      label: last.endLabel,
      region: last.endRegion,
      arrivedAt: last.endAt,
      leftAt: null,
      batteryLevel: last.endBatteryLevel,
    });
  }

  return stops.map((stop) => {
    const until = stop.leftAt ?? now;
    const here = charges.filter((charge) => charge.start_at >= stop.arrivedAt && charge.start_at < until);
    return {
      label: stop.label,
      region: stop.region,
      arrivedAt: stop.arrivedAt,
      leftAt: stop.leftAt,
      // Clamped, because two drives can overlap in a history that was imported
      // over live data or recorded twice, and "stayed −84 min" reads as a fault in
      // the page rather than in the rows behind it.
      stayedMin: stop.leftAt == null ? null : Math.max(0, (stop.leftAt - stop.arrivedAt) / 60_000),
      batteryLevel: stop.batteryLevel,
      chargeCount: here.length,
      energyKwh: total(here.map((charge) => charge.energy_kwh)),
      costCents: total(here.map((charge) => charge.cost_cents)),
    };
  });
}

/**
 * The stop the trip is named after: the farthest one from where it started, and
 * among stops equally far, the one it stayed at longest.
 *
 * Farthest first, because "longest" on its own named a day out to another town
 * after the office — the drive home went past work and parked there six hours,
 * and six hours beat the half hour spent at the actual destination. Distance is
 * what a person names a journey by; the stay only breaks ties between the
 * clustered stops of one visit (the hotel over the restaurant beside it). A stop
 * still going counts as the longest stay there is — the car is at it now.
 *
 * Stops with no coordinates fall back to the stay alone, so an imported history
 * without positions still gets a name.
 */
function destinationOf(
  stops: TripStopDto[],
  run: TripRun,
): { destinationLabel: string | null; destinationRegion: string | null } {
  const origin = run.drives[0]!;
  // Stop i is the end of drive i; an open trip's extra last stop is the last
  // drive's end, which indexing into `drives` covers as well.
  const placed = stops.map((stop, i) => {
    const drive = run.drives[i]!;
    const away =
      origin.startLat != null && origin.startLon != null && drive.endLat != null && drive.endLon != null
        ? haversineMeters(origin.startLat, origin.startLon, drive.endLat, drive.endLon)
        : null;
    return { stop, away, stayed: stop.stayedMin ?? Infinity };
  });

  const farthest = Math.max(...placed.map((p) => p.away ?? -1));
  // Within a couple of kilometres of the farthest is the same visit, not a
  // different destination — pick by stay inside that cluster.
  const candidates =
    farthest < 0 ? placed : placed.filter((p) => p.away != null && farthest - p.away < 2_000);
  const best = candidates.reduce<(typeof placed)[number] | null>(
    (longest, p) => (longest == null || p.stayed > longest.stayed ? p : longest),
    null,
  );
  return { destinationLabel: best?.stop.label ?? null, destinationRegion: best?.stop.region ?? null };
}

function toDto(run: TripRun, allCharges: ChargeRow[], now: number, truncated: boolean): TripDto {
  const drives = run.drives;
  const first = drives[0]!;
  const last = drives[drives.length - 1]!;
  // The furthest end, not the last row's: overlapping rows exist, and the trip's own
  // span is what the map and the state band are drawn over.
  const endAt = Math.max(...drives.map((drive) => Math.max(drive.endAt, drive.startAt)));
  const stops = stopsOf(run, allCharges, now);

  // Only the charges inside the journey. Handing the whole window's list to `lowest`
  // below reported every trip's low point as the lowest the pack reached all year.
  const until = run.closed ? endAt : now;
  const charges = allCharges.filter((charge) => charge.start_at >= first.endAt && charge.start_at < until);

  const distanceKm = total(drives.map((drive) => drive.distanceKm));
  const energyKwh = total(drives.map((drive) => drive.energyKwh));

  // One leg per drive, so the page can lay the journey out as it went: leg,
  // stop, leg, stop. The stops between them are `stops` above.
  const legs: TripLegDto[] = drives.map((drive) => ({
    startAt: drive.startAt,
    endAt: drive.endAt,
    distanceKm: drive.distanceKm,
    durationMin: drive.durationMin,
  }));

  return {
    startAt: first.startAt,
    endAt,
    truncated,
    open: !run.closed,
    startLabel: first.startLabel,
    endLabel: last.endLabel,
    startRegion: first.startRegion,
    endRegion: last.endRegion,
    ...destinationOf(stops, run),
    driveCount: drives.length,
    distanceKm,
    drivingMin: total(drives.map((drive) => drive.durationMin)),
    energyKwh,
    consumptionKwhPer100km: consumptionPer100km(energyKwh, distanceKm),
    chargeCount: total(stops.map((stop) => stop.chargeCount)) ?? 0,
    chargedKwh: total(stops.map((stop) => stop.energyKwh)),
    costCents: total(stops.map((stop) => stop.costCents)),
    startBatteryLevel: first.startBatteryLevel,
    endBatteryLevel: last.endBatteryLevel,
    // The charges' starting levels count too: the pack's low point of a long day is
    // usually the moment it was plugged in, not the end of a drive.
    minBatteryLevel: lowest([
      ...drives.map((drive) => drive.endBatteryLevel),
      ...charges.map((charge) => charge.start_battery_level),
    ]),
    stops,
    legs,
  };
}

export async function listTrips(db: SqlDatabase, filters: TripFilters): Promise<TripsDto> {
  const now = filters.now ?? Date.now();
  const readFrom = filters.from - OVERREAD_MS;
  // Never past the present: reading ahead of `now` costs nothing but would make the
  // window depend on the clock for no gain, since there is nothing there yet.
  const readTo = Math.min(filters.to + OVERREAD_MS, Math.max(filters.to, now));

  const drives = await db
    .prepare(
      `SELECT d.id, d.start_date_at AS start_at, d.end_date_at AS end_at, d.distance,
              d.duration_min, ${energyExpr(filters.preferredRange)} AS energy_kwh,
              ${DRIVE_START_LABEL} AS start_label, ${DRIVE_END_LABEL} AS end_label,
              ${DRIVE_START_REGION} AS start_region, ${DRIVE_END_REGION} AS end_region,
              d.start_geofence_id, d.end_geofence_id, d.start_address_id, d.end_address_id,
              sp.battery_level AS start_battery_level, ep.battery_level AS end_battery_level,
              sp.latitude AS start_lat, sp.longitude AS start_lon,
              ep.latitude AS end_lat, ep.longitude AS end_lon
       FROM drives d ${DRIVE_JOINS}
       LEFT JOIN positions sp ON sp.id = d.start_position_id
       LEFT JOIN positions ep ON ep.id = d.end_position_id
       WHERE d.car_id = ? AND d.end_date_at IS NOT NULL
         AND d.start_date_at >= ? AND d.start_date_at < ?
       ORDER BY d.start_date_at, d.id`,
    )
    .bind(filters.carId, readFrom, readTo)
    .all<DriveRow>();

  const charges = await db
    .prepare(
      `SELECT cp.start_date_at AS start_at, ${CHARGE_LABEL} AS label,
              cp.charge_energy_added AS energy_kwh, cp.cost_cents AS cost_cents,
              cp.start_battery_level AS start_battery_level
       FROM charging_processes cp ${CHARGE_JOINS}
       WHERE cp.car_id = ? AND cp.end_date_at IS NOT NULL AND ${HAS_ENERGY}
         AND cp.start_date_at >= ? AND cp.start_date_at < ?
       ORDER BY cp.start_date_at, cp.id`,
    )
    .bind(filters.carId, readFrom, readTo)
    .all<ChargeRow>();

  const input: TripDrive[] = drives.results.map((row) => ({
    id: row.id,
    startAt: row.start_at,
    endAt: row.end_at,
    distanceKm: row.distance,
    durationMin: row.duration_min,
    energyKwh: row.energy_kwh,
    startLabel: row.start_label,
    endLabel: row.end_label,
    startRegion: row.start_region,
    endRegion: row.end_region,
    startPlace: place(row.start_geofence_id, row.start_address_id),
    endPlace: place(row.end_geofence_id, row.end_address_id),
    startLat: row.start_lat,
    startLon: row.start_lon,
    endLat: row.end_lat,
    endLon: row.end_lon,
    startBatteryLevel: row.start_battery_level,
    endBatteryLevel: row.end_battery_level,
  }));

  // Normalized here, not left to detectTrips alone: the window totals below have
  // to be built from the same rows the grouping saw, or a duplicated batch and
  // the recorder's split segments would count against "everyday driving".
  const cleaned = normalizeTripDrives(input);
  const runs = detectTrips(cleaned, { ...TRIP_DEFAULTS, now });

  /*
    Trips are grouped over a wider span than the window asked for, and only the ones
    the window actually contains any of are returned — newest first, like every other
    list here. A run that reaches either edge of what was *read* may have more drives
    beyond it, so it is flagged rather than presented as a whole journey.

    The overlap test is half-open at both ends, matching the window itself, so a trip
    that ends exactly as the window begins belongs to the earlier one alone.
  */
  const kept = runs
    .map((run) => {
      const first = run.drives[0]!;
      const last = run.drives[run.drives.length - 1]!;
      const truncated = first.startAt <= readFrom || last.endAt >= readTo;
      return toDto(run, charges.results, now, truncated);
    })
    .filter((trip) => trip.endAt > filters.from && trip.startAt < filters.to)
    .reverse();

  // Both halves are measured over drives that started inside the window, so one is
  // a share of their sum. Summing whole trips against in-window everyday driving
  // would compare a journey that began last month with a week of commuting.
  const inWindow = cleaned.filter((drive) => drive.startAt >= filters.from && drive.startAt < filters.to);
  const onTrips = new Set(runs.flatMap((run) => run.drives.map((drive) => drive.id)));
  const tripDistanceKm = total(inWindow.filter((drive) => onTrips.has(drive.id)).map((drive) => drive.distanceKm));
  const otherDistanceKm = total(
    inWindow.filter((drive) => !onTrips.has(drive.id)).map((drive) => drive.distanceKm),
  );

  return {
    from: filters.from,
    to: filters.to,
    trips: kept,
    tripDistanceKm,
    otherDistanceKm,
    criteria: {
      minDistanceKm: TRIP_DEFAULTS.minDistanceKm,
      minDrives: TRIP_DEFAULTS.minDrives,
      returnStopHours: TRIP_DEFAULTS.returnStopMs / 3_600_000,
      longStopHours: TRIP_DEFAULTS.longStopMs / 3_600_000,
    },
  };
}
