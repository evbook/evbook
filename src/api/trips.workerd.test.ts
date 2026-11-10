import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { TripsDto } from "@shared/api-types";
import { authed, login } from "../../test/http";
import { resetLoggedCar } from "../../test/seed";

/** HTTP tests for the trip roll-up. The grouping rules are covered in core/trips. */

const CAR_ID = 14;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Well clear of now, so the newest run is always closed by the two-day rule. */
const START = Date.now() - 60 * DAY;

const reset = () => resetLoggedCar(CAR_ID, { efficiency: 0.15 });

/**
 * A place with a name, so the labels and the return rule have something to use.
 * The name is the label and Berlin the region beside it — these are geocoded
 * addresses, not geofences, which is what makes them carry a town at all.
 */
async function seedPlace(name: string): Promise<number> {
  const row = await env.DB.prepare(
    "INSERT INTO addresses (display_name, name, city, latitude, longitude, inserted_at, updated_at) " +
      "VALUES (?, ?, 'Berlin', 52.5, 13.4, 0, 0) RETURNING id",
  )
    .bind(`${name}, Berlin`, name)
    .first<{ id: number }>();
  return row!.id;
}

interface DriveOpts {
  at: number;
  km: number;
  from: number;
  to: number;
  hours?: number;
  soc?: [number, number];
  /** Where the two ends sit, for tests about naming a trip by its farthest stop. */
  coords?: [[number, number], [number, number]];
}

async function addDrive(opts: DriveOpts): Promise<number> {
  const length = (opts.hours ?? 1) * HOUR;
  const [startSoc, endSoc] = opts.soc ?? [80, 40];

  const positions: number[] = [];
  for (const [index, soc] of [startSoc, endSoc].entries()) {
    const [lat, lon] = opts.coords?.[index] ?? [52.5 + index * 0.5, 13.4];
    const row = await env.DB.prepare(
      "INSERT INTO positions (car_id, date_at, latitude, longitude, battery_level, elevation) " +
        "VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
    )
      .bind(CAR_ID, opts.at + index * length, lat, lon, soc, 40 + index * 500)
      .first<{ id: number }>();
    positions.push(row!.id);
  }

  const drive = await env.DB.prepare(
    "INSERT INTO drives (car_id, start_date_at, end_date_at, distance, duration_min, " +
      "start_address_id, end_address_id, start_position_id, end_position_id, " +
      "start_rated_range_km, end_rated_range_km) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
  )
    .bind(
      CAR_ID,
      opts.at,
      opts.at + length,
      opts.km,
      length / 60_000,
      opts.from,
      opts.to,
      positions[0],
      positions[1],
      400,
      // 0.15 kWh per km of range, so the energy figure is derivable.
      400 - opts.km,
    )
    .first<{ id: number }>();

  // The positions belong to the drive, which is what the route endpoint reads.
  await env.DB.prepare("UPDATE positions SET drive_id = ? WHERE id IN (?, ?)")
    .bind(drive!.id, positions[0], positions[1])
    .run();
  return drive!.id;
}

async function addCharge(opts: { at: number; energy: number; costCents: number; addressId?: number; soc?: number }) {
  const cproc = await env.DB.prepare(
    "INSERT INTO charging_processes (car_id, start_date_at, end_date_at, charge_energy_added, charge_energy_used, " +
      "duration_min, start_battery_level, end_battery_level, cost_cents, address_id) " +
      "VALUES (?, ?, ?, ?, ?, 40, ?, 80, ?, ?) RETURNING id",
  )
    .bind(CAR_ID, opts.at, opts.at + 40 * 60_000, opts.energy, opts.energy, opts.soc ?? 20, opts.costCents, opts.addressId ?? null)
    .first<{ id: number }>();

  await env.DB.prepare(
    "INSERT INTO charges (charging_process_id, date_at, charge_energy_added, charger_power, " +
      "ideal_battery_range_km, fast_charger_present) VALUES (?, ?, ?, 120, 300, 1)",
  )
    .bind(cproc!.id, opts.at, opts.energy)
    .run();
}

async function fetchTrips(cookie: string, extra = ""): Promise<TripsDto> {
  const from = START - DAY;
  const to = Date.now();
  const res = await authed(cookie, `/api/v1/trips?carId=${CAR_ID}&from=${from}&to=${to}${extra}`);
  expect(res.status).toBe(200);
  return (await res.json()) as TripsDto;
}

/**
 * Out to the coast with a charging stop, a night away, and home again — which is
 * one trip and five rows.
 */
async function seedRoadTrip(): Promise<{ home: number; services: number; coast: number }> {
  const home = await seedPlace("Home");
  const services = await seedPlace("Motorway services");
  const coast = await seedPlace("Coast hotel");

  await addDrive({ at: START, km: 200, from: home, to: services, hours: 2, soc: [90, 40] });
  await addCharge({ at: START + 2 * HOUR + 5 * 60_000, energy: 30, costCents: 1200, addressId: services, soc: 40 });
  await addDrive({ at: START + 3 * HOUR, km: 180, from: services, to: coast, hours: 2, soc: [80, 35] });
  await addDrive({ at: START + 26 * HOUR, km: 380, from: coast, to: home, hours: 4, soc: [85, 20] });
  return { home, services, coast };
}

describe("trip roll-up", () => {
  beforeEach(reset);

  it("groups the drives of one journey and totals what it took", async () => {
    const cookie = await login();
    await seedRoadTrip();

    const body = await fetchTrips(cookie);

    expect(body.trips).toHaveLength(1);
    const trip = body.trips[0]!;
    expect(trip.driveCount).toBe(3);
    expect(trip.distanceKm).toBe(760);
    expect(trip.startLabel).toBe("Home");
    expect(trip.endLabel).toBe("Home");
    // The town rides along beside the label rather than inside it, for the page to dim.
    expect(trip.startRegion).toBe("Berlin");
    expect(trip.open).toBe(false);
    expect(trip.drivingMin).toBe(8 * 60);
    // Range used times the car's efficiency, as everywhere else in the app.
    expect(trip.energyKwh).toBeCloseTo(760 * 0.15, 5);
    expect(trip.consumptionKwhPer100km).toBeCloseTo(15, 5);
  });

  it("names the trip after where it stayed longest", async () => {
    const cookie = await login();
    await seedRoadTrip();

    // Twenty minutes at the services against twenty hours at the coast.
    expect((await fetchTrips(cookie)).trips[0]!.destinationLabel).toBe("Coast hotel");
  });

  /*
    Distance beats parking time. A day out to another town used to be named after
    the office, because the drive home stopped there for the whole afternoon and
    six hours beat the half hour spent at the actual destination.
  */
  it("names the trip after its farthest stop, not its longest parking", async () => {
    const cookie = await login();
    const home = await seedPlace("Home");
    const town = await seedPlace("Far town");
    const office = await seedPlace("Office");

    const at = { home: [52.5, 13.4], town: [53.1, 13.4], office: [52.52, 13.4] } as const;
    await addDrive({ at: START, km: 70, from: home, to: town, coords: [[...at.home], [...at.town]] });
    // Half an hour in the far town, then the whole workday parked beside home.
    await addDrive({ at: START + 1.5 * HOUR, km: 68, from: town, to: office, coords: [[...at.town], [...at.office]] });
    await addDrive({ at: START + 11 * HOUR, km: 2, from: office, to: home, coords: [[...at.office], [...at.home]] });

    expect((await fetchTrips(cookie)).trips[0]!.destinationLabel).toBe("Far town");
  });

  it("lists the stops in between, with what was charged at each", async () => {
    const cookie = await login();
    await seedRoadTrip();

    const stops = (await fetchTrips(cookie)).trips[0]!.stops;

    expect(stops.map((stop) => stop.label)).toEqual(["Motorway services", "Coast hotel"]);
    // Arrived two hours in, left an hour later; the charge sat inside that hour.
    expect(stops[0]).toMatchObject({ chargeCount: 1, energyKwh: 30, costCents: 1200, stayedMin: 60 });
    expect(stops[1]).toMatchObject({ chargeCount: 0, energyKwh: null, costCents: null });
    expect(stops[1]!.stayedMin).toBe(21 * 60);
    // The pack on arrival — what each drive ended on, not what the next left with.
    expect(stops.map((stop) => stop.batteryLevel)).toEqual([40, 35]);
  });

  it("carries one leg per drive, so the itinerary can interleave them with the stops", async () => {
    const cookie = await login();
    await seedRoadTrip();

    const trip = (await fetchTrips(cookie)).trips[0]!;
    expect(trip.legs).toHaveLength(trip.driveCount);
    expect(trip.legs[0]).toEqual({ startAt: START, endAt: START + 2 * HOUR, distanceKm: 200, durationMin: 120 });
    // Each leg ends where the next stop begins, which is what lets the page draw
    // leg, stop, leg, stop without guessing.
    expect(trip.legs[0]!.endAt).toBe(trip.stops[0]!.arrivedAt);
  });

  it("counts the journey's charging, not what went in after getting home", async () => {
    const cookie = await login();
    const { home } = await seedRoadTrip();
    // Plugged in at home once the trip is over: not part of what the trip cost.
    await addCharge({ at: START + 31 * HOUR, energy: 55, costCents: 900, addressId: home });

    const trip = (await fetchTrips(cookie)).trips[0]!;
    expect(trip.chargeCount).toBe(1);
    expect(trip.chargedKwh).toBe(30);
    expect(trip.costCents).toBe(1200);
  });

  it("reports the pack's low point across drives and plug-ins alike", async () => {
    const cookie = await login();
    await seedRoadTrip();
    // Three weeks later and much lower, and nothing to do with this trip: the low
    // point is the journey's, not the lowest the pack reached all year.
    await addCharge({ at: START + 21 * DAY, energy: 40, costCents: 800, soc: 4 });

    const trip = (await fetchTrips(cookie)).trips[0]!;
    expect(trip.startBatteryLevel).toBe(90);
    expect(trip.endBatteryLevel).toBe(20);
    expect(trip.minBatteryLevel).toBe(20);
  });

  it("finds the low point at a plug-in when that is lower than any drive's end", async () => {
    const cookie = await login();
    const home = await seedPlace("Home");
    const far = await seedPlace("Far");

    await addDrive({ at: START, km: 300, from: home, to: far, hours: 3, soc: [90, 25] });
    await addCharge({ at: START + 4 * HOUR, energy: 40, costCents: 1400, addressId: far, soc: 12 });
    await addDrive({ at: START + 6 * HOUR, km: 300, from: far, to: home, hours: 3, soc: [80, 30] });

    // 12 % when it was plugged in, against 25 and 30 at the ends of the two drives.
    expect((await fetchTrips(cookie)).trips[0]!.minBatteryLevel).toBe(12);
  });

  /*
    The end edge. Reading only backwards returned the outbound half of a trip that
    crossed the window's end as a finished journey, and the next window returned the
    whole of it again under the same startAt — so paging through a year counted the
    outbound leg twice.
  */
  it("groups a journey that runs past the end of the window to its real end", async () => {
    const cookie = await login();
    const home = await seedPlace("Home");
    const coast = await seedPlace("Coast");

    const boundary = START + 2 * DAY;
    await addDrive({ at: boundary - 30 * HOUR, km: 400, from: home, to: coast, hours: 4 });
    await addDrive({ at: boundary + 6 * HOUR, km: 400, from: coast, to: home, hours: 4 });

    const res = await authed(cookie, `/api/v1/trips?carId=${CAR_ID}&from=${START - DAY}&to=${boundary}`);
    const body = (await res.json()) as TripsDto;

    expect(body.trips).toHaveLength(1);
    const trip = body.trips[0]!;
    expect(trip.driveCount).toBe(2);
    expect(trip.distanceKm).toBe(800);
    expect(trip.endLabel).toBe("Home");
    // It really did end, and the half inside the window is not a journey of its own.
    expect(trip.open).toBe(false);
  });

  it("does not report a boundary-crossing journey's distance in both windows", async () => {
    const cookie = await login();
    const home = await seedPlace("Home");
    const coast = await seedPlace("Coast");

    const boundary = START + 2 * DAY;
    await addDrive({ at: boundary - 30 * HOUR, km: 400, from: home, to: coast, hours: 4 });
    await addDrive({ at: boundary + 6 * HOUR, km: 400, from: coast, to: home, hours: 4 });

    const window = async (from: number, to: number) =>
      (await (await authed(cookie, `/api/v1/trips?carId=${CAR_ID}&from=${from}&to=${to}`)).json()) as TripsDto;

    const before = await window(START - DAY, boundary);
    const after = await window(boundary, boundary + 3 * DAY);

    // The same journey is listed in both, since both contain part of it — but the
    // per-window distance splits between them rather than being counted twice.
    expect(before.trips[0]!.startAt).toBe(after.trips[0]!.startAt);
    expect(before.tripDistanceKm).toBe(400);
    expect(after.tripDistanceKm).toBe(400);
    expect(before.otherDistanceKm).toBeNull();
  });

  it("splits the window's distance between trips and everyday driving", async () => {
    const cookie = await login();
    const home = await seedPlace("Home");
    const work = await seedPlace("Work");
    const coast = await seedPlace("Coast");

    await addDrive({ at: START, km: 300, from: home, to: coast, hours: 3 });
    await addDrive({ at: START + 6 * HOUR, km: 300, from: coast, to: home, hours: 3 });
    await addDrive({ at: START + 2 * DAY, km: 25, from: home, to: work });
    await addDrive({ at: START + 2 * DAY + 9 * HOUR, km: 25, from: work, to: home });

    const body = await fetchTrips(cookie);
    expect(body.tripDistanceKm).toBe(600);
    expect(body.otherDistanceKm).toBe(50);
  });

  /*
    Truncation is not about the length of the journey but about whether it reaches the
    edge of what was read — a fortnight either side of the window. A month on the road
    seen through a one-day window in the middle of it is cut at both ends, and says so
    rather than reporting a beginning that is really just the earliest drive in view.
  */
  it("says when a journey runs past what it could read", async () => {
    const cookie = await login();
    // A different place every night, so the car never returns and only the read
    // boundary can end the run.
    const places: number[] = [];
    for (let day = 0; day <= 30; day++) places.push(await seedPlace(`Stop ${day}`));

    for (let day = 0; day < 30; day++) {
      await addDrive({ at: START + day * DAY, km: 200, from: places[day]!, to: places[day + 1]!, hours: 2 });
    }

    const midway = START + 20 * DAY;
    const res = await authed(cookie, `/api/v1/trips?carId=${CAR_ID}&from=${midway}&to=${midway + DAY}`);
    const body = (await res.json()) as TripsDto;

    expect(body.trips).toHaveLength(1);
    expect(body.trips[0]!.truncated).toBe(true);
  });

  it("does not call an ordinary journey truncated", async () => {
    const cookie = await login();
    await seedRoadTrip();
    expect((await fetchTrips(cookie)).trips[0]!.truncated).toBe(false);
  });

  it("keeps the everyday driving out, and says how much of it there was", async () => {
    const cookie = await login();
    const home = await seedPlace("Home");
    const work = await seedPlace("Work");

    for (const day of [0, 1, 2]) {
      await addDrive({ at: START + day * DAY, km: 25, from: home, to: work });
      await addDrive({ at: START + day * DAY + 9 * HOUR, km: 25, from: work, to: home });
    }

    const body = await fetchTrips(cookie);
    expect(body.trips).toEqual([]);
    expect(body.otherDistanceKm).toBe(150);
  });

  it("returns the newest journey first", async () => {
    const cookie = await login();
    const home = await seedPlace("Home");
    const north = await seedPlace("North");
    const south = await seedPlace("South");

    await addDrive({ at: START, km: 200, from: home, to: north, hours: 2 });
    await addDrive({ at: START + 6 * HOUR, km: 200, from: north, to: home, hours: 2 });
    await addDrive({ at: START + 10 * DAY, km: 300, from: home, to: south, hours: 3 });
    await addDrive({ at: START + 10 * DAY + 8 * HOUR, km: 300, from: south, to: home, hours: 3 });

    const body = await fetchTrips(cookie);
    expect(body.trips.map((trip) => trip.destinationLabel)).toEqual(["South", "North"]);
    expect(body.trips[0]!.startAt).toBeGreaterThan(body.trips[1]!.startAt);
  });

  it("marks a journey still under way, and gives its current stop no leaving time", async () => {
    const cookie = await login();
    const home = await seedPlace("Home");
    const away = await seedPlace("Away");
    const now = Date.now();

    await addDrive({ at: now - 6 * HOUR, km: 200, from: home, to: away, hours: 2 });
    await addDrive({ at: now - 3 * HOUR, km: 200, from: away, to: away, hours: 2 });

    const body = await fetchTrips(cookie);
    const trip = body.trips[0]!;
    expect(trip.open).toBe(true);
    expect(trip.stops.at(-1)).toMatchObject({ label: "Away", leftAt: null, stayedMin: null });
  });

  it("groups a journey that began before the window from its real start", async () => {
    const cookie = await login();
    const home = await seedPlace("Home");
    const coast = await seedPlace("Coast");

    // Left before the window opens, came back inside it — a night away, which is
    // under the two-day rule and so is still one journey.
    await addDrive({ at: START, km: 300, from: home, to: coast, hours: 3 });
    await addDrive({ at: START + DAY, km: 300, from: coast, to: home, hours: 3 });

    const res = await authed(
      cookie,
      `/api/v1/trips?carId=${CAR_ID}&from=${START + 12 * HOUR}&to=${Date.now()}`,
    );
    const body = (await res.json()) as TripsDto;

    expect(body.trips).toHaveLength(1);
    expect(body.trips[0]!.startAt).toBe(START);
    expect(body.trips[0]!.driveCount).toBe(2);
  });

  it("says what it counted as a trip", async () => {
    const cookie = await login();
    const body = await fetchTrips(cookie);
    expect(body.criteria).toEqual({
      minDistanceKm: 60,
      minDrives: 2,
      returnStopHours: 1,
      longStopHours: 48,
    });
  });

  it("keeps one car's drives out of another's journeys", async () => {
    const cookie = await login();
    await seedRoadTrip();
    await env.DB.prepare("INSERT INTO cars (id, vin, inserted_at, updated_at) VALUES (?, ?, 0, 0)")
      .bind(CAR_ID + 1, `VIN${CAR_ID + 1}`)
      .run();
    await env.DB.prepare(
      "INSERT INTO drives (car_id, start_date_at, end_date_at, distance) VALUES (?, ?, ?, 999)",
    )
      .bind(CAR_ID + 1, START + HOUR, START + 2 * HOUR)
      .run();

    const body = await fetchTrips(cookie);
    expect(body.trips[0]!.distanceKm).toBe(760);
  });

  it("requires a car", async () => {
    const cookie = await login();
    expect((await authed(cookie, "/api/v1/trips")).status).toBe(400);
  });
});

describe("the route behind a trip's map", () => {
  beforeEach(reset);

  it("reports the ground the route covered", async () => {
    const cookie = await login();
    await seedRoadTrip();

    const res = await authed(cookie, `/api/v1/drives/route?carId=${CAR_ID}&from=${START - DAY}&to=${Date.now()}`);
    const body = (await res.json()) as { minElevationM: number | null; maxElevationM: number | null };

    expect(body.minElevationM).toBe(40);
    expect(body.maxElevationM).toBe(540);
  });
});
