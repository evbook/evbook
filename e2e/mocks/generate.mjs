/**
 * Expands a declarative world into database rows.
 *
 * Each car is simulated chronologically so the history is internally
 * consistent: odometer only grows, state of charge falls on drives and rises on
 * charges, and rated range follows a pack that fades a little every day.
 * Nothing here reads the clock except the `now` argument, and all jitter comes
 * from a seeded PRNG, so the same `now` always produces the same rows.
 *
 * The default world is the e2e mock world (`world.mjs`); `demo/world.mjs`
 * passes its own. A world looks like:
 *
 *   {
 *     timezone,                 // IANA zone all wall-clock times are in
 *     places,                   // shared named places (addresses + geofences)
 *     routes,                   // shared routes between places
 *     thinning?,                // { afterDays, driveSamples } — long histories
 *                               // keep only a sketch of old drives
 *     cars: [{
 *       ...car fields,          // id, vin, model, efficiency, capacityKwh, …
 *       seed,                   // per-car PRNG seed
 *       startOdometerKm, startSoc,
 *       capacityFadePerDay?,    // linear fade, kWh per day (the e2e world)
 *       fade?,                  // { kwhPerSqrtDay, priorDays } — sqrt-of-age
 *                               // fade for packs that were not new on day one
 *       climate?,               // { meanC, amplitudeC, coldestDayOfYear,
 *                               //   diurnalC } — seasonal outside temperature;
 *                               // absent = the flat 70-day e2e formula
 *       schedule, live,
 *     }],
 *   }
 */

import { tyreModel, tyreReadings } from "./tyres.mjs";
import { CAR, LIVE, PLACES, ROUTES, SCHEDULE, TIMEZONE } from "./world.mjs";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Samples written per drive and per charging session. */
const DRIVE_SAMPLES = 22;
const CHARGE_SAMPLES = 16;

/** The world the e2e suite sees — one car, ten weeks, flat mild weather. */
function e2eWorld() {
  return {
    timezone: TIMEZONE,
    places: PLACES,
    routes: ROUTES,
    cars: [{ ...CAR, seed: 20_260_730, startOdometerKm: 14_085.3, startSoc: 74, schedule: SCHEDULE, live: LIVE }],
  };
}

/** mulberry32 — small, seeded, good enough for jitter. */
/**
 * The uncertainty columns (migration 0006) of a row that was observed in full.
 * Spread first into every drive and session, so the first row of each table —
 * which names the INSERT's columns — has them all.
 */
const UNCERTAINTY_NONE = {
  start_after_at: null,
  start_before_at: null,
  end_after_at: null,
  end_before_at: null,
  reconstructed: 0,
};

/**
 * A session's cost columns (migrations 0006, 0008), left for the app to fill:
 * a session at a priced place is queued (`cost_stale`), and the seed then runs
 * the real pricing over the file (scripts/reprice.ts) instead of this generator
 * carrying a second copy of the tariff arithmetic.
 */
const UNPRICED = (target) => ({
  cost_max_cents: null,
  cost_source: null,
  cost_stale: target.geofenceId != null ? 1 : 0,
});

/**
 * A fence's tariff as the app stores it: one dated price from the start of the
 * history, with the fence's time windows if it has any (`fence.windows`, in
 * the API's TariffWindowDto shape).
 */
function fenceTariff(fence, historyStart, timeZone) {
  const validFrom = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(historyStart));
  return JSON.stringify([
    {
      validFrom,
      billingType: fence.billing,
      rate: fence.rate,
      sessionFeeCents: fence.sessionFeeCents ?? null,
      windows: fence.windows ?? [],
    },
  ]);
}

/** Both ends of an event nobody saw lie anywhere in the gap. */
const hiddenSpan = (after, before) => ({
  start_after_at: after,
  start_before_at: before,
  end_after_at: after,
  end_before_at: before,
});

/** A stable small number from an instant's minute, for choices that must not draw from the PRNG. */
const minuteHash = (at) => Math.abs(Math.imul(Math.floor(at / MINUTE), 2654435761) >>> 0) % 997;

function prng(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const round = (n, digits = 2) => {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
};

/** Offset of a time zone from UTC at a given instant, in milliseconds. */
function tzOffsetMs(at, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(at));
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return asUtc - Math.floor(at / 1000) * 1000;
}

/**
 * Local wall-clock time on a given day, resolved to a UTC instant.
 *
 * `dayStartUtc` is already the UTC instant of local midnight, so the wall clock
 * has simply advanced by the time of day and no zone conversion is owed. The
 * remaining correction is for the one thing that genuinely needs it, a day the
 * zone changed its offset part-way through.
 */
function atLocal(dayStartUtc, hhmm, timeZone) {
  const [h, m] = hhmm.split(":").map(Number);
  const guess = dayStartUtc + h * HOUR + m * MINUTE;
  return guess - (tzOffsetMs(guess, timeZone) - tzOffsetMs(dayStartUtc, timeZone));
}

/** Midnight (local) of the day `daysAgo` before `now`, as a UTC instant. */
function localMidnight(now, daysAgo, timeZone) {
  const target = now - daysAgo * DAY;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(target));
  const [y, m, d] = parts.split("-").map(Number);
  const utcMidnight = Date.UTC(y, m - 1, d);
  return utcMidnight - tzOffsetMs(utcMidnight, timeZone);
}

function weekdayOf(at, timeZone) {
  const name = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(new Date(at));
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(name);
}

/** Day of the year (1-366) of an instant, in the world's time zone. */
function dayOfYear(at, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(at));
  const [y, m, d] = parts.split("-").map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 1)) / DAY) + 1;
}

/** Metres between two coordinates (equirectangular is plenty at city scale). */
function distanceM([lat1, lon1], [lat2, lon2]) {
  const x = (((lon2 - lon1) * Math.PI) / 180) * Math.cos((((lat1 + lat2) / 2) * Math.PI) / 180);
  const y = ((lat2 - lat1) * Math.PI) / 180;
  return Math.sqrt(x * x + y * y) * 6_371_000;
}

/** Walk a polyline and return `count` evenly spaced points along it. */
function interpolate(waypoints, count) {
  const legs = [];
  let total = 0;
  for (let i = 1; i < waypoints.length; i++) {
    const length = distanceM(waypoints[i - 1], waypoints[i]);
    legs.push({ from: waypoints[i - 1], to: waypoints[i], length });
    total += length;
  }
  const points = [];
  for (let i = 0; i < count; i++) {
    const target = (total * i) / (count - 1);
    let travelled = 0;
    let point = waypoints[waypoints.length - 1];
    for (const leg of legs) {
      if (travelled + leg.length >= target || leg === legs[legs.length - 1]) {
        const t = leg.length === 0 ? 0 : Math.min(1, (target - travelled) / leg.length);
        point = [leg.from[0] + (leg.to[0] - leg.from[0]) * t, leg.from[1] + (leg.to[1] - leg.from[1]) * t];
        break;
      }
      travelled += leg.length;
    }
    points.push(point);
  }
  return points;
}

/** Bell-ish speed profile: accelerate, cruise, slow down. */
function speedFactor(progress) {
  return Math.sin(Math.PI * Math.min(1, Math.max(0, progress))) ** 0.55;
}

/**
 * Days a one-off journey happens on. The routine gives way to them: the
 * schedule's repeats are keyed on weekday, so a one-off drive day that happens
 * to land on a Tuesday would otherwise have the commute laid over the top of
 * it — the car driving to the office at 08:12 while already an hour down the
 * motorway.
 *
 * Only days with a one-off *drive* are cleared. A one-off charge or a firmware
 * install sits perfectly happily beside the routine, and clearing those days
 * too would throw away ordinary history for no reason.
 *
 * `clearsDays: n` on an entry clears the n days after the journey as well —
 * for a holiday, where the car is parked somewhere else all week and the
 * school run cannot happen from there.
 */
function journeyDays(schedule) {
  const days = new Set();
  for (const entry of schedule) {
    if (entry.on && entry.events.some((event) => event.kind === "drive")) {
      for (let i = 0; i <= (entry.clearsDays ?? 0); i++) days.add(entry.on.daysAgo - i);
    }
  }
  return days;
}

/** Flatten a schedule into a chronological list of events with absolute times. */
function expandSchedule(now, schedule, timeZone) {
  const events = [];
  const journeys = journeyDays(schedule);

  const push = (dayStart, event, index) => {
    events.push({ ...event, at: atLocal(dayStart, event.at, timeZone), order: index });
  };

  for (const entry of schedule) {
    if (entry.on) {
      const dayStart = localMidnight(now, entry.on.daysAgo, timeZone);
      entry.events.forEach((event, i) => push(dayStart, event, i));
      continue;
    }
    const { fromDaysAgo, toDaysAgo, weekdays, everyNthWeek } = entry.repeat;
    let weekIndex = 0;
    let lastWeekday = -1;
    for (let daysAgo = fromDaysAgo; daysAgo >= toDaysAgo; daysAgo--) {
      const dayStart = localMidnight(now, daysAgo, timeZone);
      const weekday = weekdayOf(dayStart, timeZone);
      if (weekday <= lastWeekday) weekIndex++;
      lastWeekday = weekday;
      if (!weekdays.includes(weekday)) continue;
      if (everyNthWeek && weekIndex % everyNthWeek !== 0) continue;
      if (journeys.has(daysAgo)) continue;
      entry.events.forEach((event, i) => {
        if (event.everyNthDay && daysAgo % event.everyNthDay !== 0) return;
        push(dayStart, event, i);
      });
    }
  }

  return events.sort((a, b) => a.at - b.at || a.order - b.order);
}

/**
 * Simulate one car through its schedule, appending rows to the shared tables.
 * Returns the car's closing state for the manifest.
 */
function simulateCar({ car, events, world, now, tables, placeIds }) {
  const { timezone } = world;
  const random = prng(car.seed);
  const { drives, positions, charging_processes: chargingProcesses, charges, states, updates } = tables;
  const historyStart = events.length > 0 ? events[0].at : now;
  const live = car.live;

  /**
   * Pack capacity at an instant. Two models: the linear kWh-per-day the
   * ten-week e2e world uses, and a square-root-of-age curve for multi-year
   * histories — degradation is front-loaded in real packs, and `priorDays`
   * says how old the pack already was when the history begins, so a car bought
   * used starts on the flat part of the curve.
   */
  const capacityAt = (at) => {
    if (car.fade) {
      const { kwhPerSqrtDay, priorDays } = car.fade;
      const ageDays = priorDays + Math.max(0, (at - historyStart) / DAY);
      return car.capacityKwh - kwhPerSqrtDay * (Math.sqrt(ageDays) - 0);
    }
    return car.capacityKwh - (car.capacityFadePerDay * (at - historyStart)) / DAY;
  };
  const maxRangeAt = (at) => capacityAt(at) / car.efficiency;

  /**
   * Outside temperature. A car with a `climate` gets a seasonal sine over the
   * year plus a day-night swing; the e2e world keeps its original ten-week
   * formula so the e2e fixtures do not move.
   */
  const seasonalTemp = (at) => {
    const { meanC, amplitudeC, coldestDayOfYear = 20, diurnalC = 6 } = car.climate;
    const doy = dayOfYear(at, timezone);
    const seasonal = meanC - amplitudeC * Math.cos((2 * Math.PI * (doy - coldestDayOfYear)) / 365.25);
    const hourLocal = ((at + tzOffsetMs(at, timezone)) % DAY) / HOUR;
    const diurnal = (-diurnalC / 2) * Math.cos((2 * Math.PI * (hourLocal - 14)) / 24);
    return seasonal + diurnal;
  };

  /** Temperature written on idle and charging samples. */
  const restingTemp = (at) => (car.climate ? round(seasonalTemp(at), 1) : live.outsideTempC);

  /** Tyre pressures: fills, temperature drift and any slow leak (tyres.mjs). */
  const tyreAt = tyreModel({
    car,
    live,
    now,
    tempAt: (at) => (car.climate ? seasonalTemp(at) : live.outsideTempC),
  });

  let odometerKm = car.startOdometerKm;
  let soc = car.startSoc;
  let stateOpenedAt = historyStart - 6 * HOUR;
  let stateKind = "asleep";
  let lastActivityAt = historyStart;

  /** Vampire drain: a parked car quietly loses about 1.3% of its charge a day. */
  const DRAIN_PCT_PER_HOUR = 0.055;
  const applyIdleDrain = (at) => {
    const hours = Math.max(0, (at - lastActivityAt) / HOUR);
    soc = Math.max(4, soc - hours * DRAIN_PCT_PER_HOUR);
  };

  const rangeFor = (at, level) => (maxRangeAt(at) * level) / 100;
  const nextId = (rows) => rows.length + 1;

  /**
   * Close the open state row and open a new one. Transitions are clamped so a
   * window never ends before it began — events can be closer together than the
   * sleep delays this walks forward by.
   */
  const setState = (kind, at) => {
    if (kind === stateKind) return;
    const when = Math.max(at, stateOpenedAt);
    states.push({
      id: nextId(states),
      car_id: car.id,
      state: stateKind,
      start_date_at: stateOpenedAt,
      end_date_at: when,
    });
    stateKind = kind;
    stateOpenedAt = when;
  };

  /** A parked sample, so idle-loss and sleep screens have something to chew on. */
  const idleSample = (at, place, level) => {
    const outsideTemp = restingTemp(at);
    positions.push(
      makePosition({
        id: nextId(positions),
        driveId: null,
        at,
        lat: place.lat,
        lon: place.lon,
        speed: null,
        power: 0,
        odometer: odometerKm,
        level,
        rangeKm: rangeFor(at, level),
        outsideTemp,
        insideTemp: outsideTemp + 1.5,
        climateOn: false,
      }),
    );
  };

  function makePosition(o) {
    return {
      id: o.id,
      car_id: car.id,
      drive_id: o.driveId,
      date_at: Math.round(o.at),
      latitude: round(o.lat, 6),
      longitude: round(o.lon, 6),
      speed: o.speed == null ? null : Math.round(o.speed),
      power: Math.round(o.power),
      odometer: round(o.odometer, 3),
      elevation: o.elevation ?? null,
      ideal_battery_range_km: round(o.rangeKm * 1.09, 2),
      rated_battery_range_km: round(o.rangeKm, 2),
      est_battery_range_km: round(o.rangeKm * 0.94, 2),
      battery_level: Math.round(o.level),
      usable_battery_level: Math.round(o.level) - (o.level > 20 ? 1 : 0),
      outside_temp: round(o.outsideTemp, 1),
      inside_temp: round(o.insideTemp, 1),
      fan_status: o.climateOn ? 3 : 0,
      driver_temp_setting: 21,
      passenger_temp_setting: 21,
      is_climate_on: o.climateOn ? 1 : 0,
      is_rear_defroster_on: 0,
      is_front_defroster_on: 0,
      battery_heater: 0,
      battery_heater_on: 0,
      battery_heater_no_power: 0,
      ...(() => {
        const tyre = tyreAt(o.at);
        return {
          tpms_pressure_fl: tyre.pressure_fl,
          tpms_pressure_fr: tyre.pressure_fr,
          tpms_pressure_rl: tyre.pressure_rl,
          tpms_pressure_rr: tyre.pressure_rr,
        };
      })(),
    };
  }

  function addDrive(event) {
    const route = world.routes[event.route];
    const fromKey = event.reverse ? route.to : route.from;
    const toKey = event.reverse ? route.from : route.to;
    const from = placeIds[fromKey];
    const to = placeIds[toKey];

    applyIdleDrain(event.at);
    if (event.hidden) return addHiddenDrive(event, route, from, to);

    // A drive the car woke into and pulled away on before the first sample: its
    // start is a span, from the last quiet probe, and its origin the parked spot.
    // A world can ask for a share of the drives that follow a night's sleep to
    // look like that, picked by the drive's own minute so the generator's random
    // sequence — and with it everything else in the world — stays put.
    const wakeMin =
      event.wakeMin ??
      (world.wakeStarts && stateKind === "asleep" && minuteHash(event.at) % 100 < world.wakeStarts.percent
        ? 2 + (minuteHash(event.at) % 6)
        : null);

    const waypoints = event.reverse ? [...route.waypoints].reverse() : route.waypoints;
    // Old drives in a long history keep only a sketch of their track: the
    // lists and stats read the drives table, and only the detail charts of
    // recent drives need a dense one.
    const sampleCount =
      world.thinning && now - event.at > world.thinning.afterDays * DAY ? world.thinning.driveSamples : DRIVE_SAMPLES;
    const points = interpolate(waypoints, sampleCount);
    const durationMs = route.minutes * MINUTE;
    const startAt = event.at;
    const endAt = startAt + durationMs;

    // Colder weather costs energy; so does motorway speed.
    const dayIndex = (startAt - historyStart) / DAY;
    const hourOfDay = ((startAt - historyStart) % DAY) / HOUR;
    const outsideTemp =
      event.temp ??
      (car.climate
        ? round(seasonalTemp(startAt) + (random() - 0.5) * 4, 1)
        : round(
            14 +
              5 * Math.sin((dayIndex / 70) * Math.PI) +
              3 * Math.sin(((hourOfDay - 4) / 24) * Math.PI) +
              random() * 2,
            1,
          ));
    const tempPenalty = outsideTemp < 0 ? 1.38 : outsideTemp < 8 ? 1.24 : outsideTemp < 15 ? 1.12 : 1.0;
    const speedPenalty = route.maxKmh > 120 ? 1.28 : route.maxKmh > 90 ? 1.1 : 1.0;
    const energyKwh = route.km * car.efficiency * tempPenalty * speedPenalty;

    const startLevel = soc;
    const capacity = capacityAt(startAt);
    const endLevel = Math.max(4, startLevel - (energyKwh / capacity) * 100);
    const startRange = rangeFor(startAt, startLevel);
    const endRange = rangeFor(endAt, endLevel);
    const startKm = odometerKm;
    const endKm = odometerKm + route.km;

    setState("online", startAt - 2 * MINUTE);

    const driveId = nextId(drives);
    let speedMax = 0;
    let powerMax = 0;
    let powerMin = 0;
    const firstPositionId = nextId(positions);

    // Two passes: the samples are rolled first (in the same random() order as
    // ever, so the rest of the seeded world stays put), then the odometer is
    // integrated from the speeds. Odometer used to advance linearly with time,
    // which quietly claimed the car covers as much road in a slow minute as in
    // a fast one — and drew the drive chart's time and distance x-axes as the
    // same picture. The trapezoid sums are rescaled so the drive still ends
    // exactly route.km from where it started.
    const samples = [];
    for (let i = 0; i < points.length; i++) {
      const progress = i / (points.length - 1);
      const factor = speedFactor(progress);
      const speed = Math.max(0, route.maxKmh * factor * (0.9 + random() * 0.16));
      // Regenerative braking on the way down from the cruise.
      const power = progress > 0.86 ? -(12 + random() * 26) : speed * 0.42 + random() * 9;
      const lat = points[i][0] + (random() - 0.5) * 0.00035;
      const lon = points[i][1] + (random() - 0.5) * 0.00035;
      samples.push({ progress, speed, power, lat, lon });
    }
    const stepHours = durationMs / (points.length - 1) / 3600000;
    const travelled = [0];
    for (let i = 1; i < samples.length; i++) {
      travelled.push(travelled[i - 1] + ((samples[i - 1].speed + samples[i].speed) / 2) * stepHours);
    }
    const totalKm = travelled[travelled.length - 1];
    for (let i = 0; i < samples.length; i++) {
      const { progress, speed, power, lat, lon } = samples[i];
      const at = startAt + durationMs * progress;
      const level = startLevel + (endLevel - startLevel) * progress;
      speedMax = Math.max(speedMax, speed);
      powerMax = Math.max(powerMax, power);
      powerMin = Math.min(powerMin, power);
      positions.push(
        makePosition({
          id: nextId(positions),
          driveId,
          at,
          lat,
          lon,
          speed,
          power,
          odometer: startKm + (totalKm > 0 ? (travelled[i] / totalKm) * route.km : route.km * progress),
          level,
          rangeKm: rangeFor(at, level),
          outsideTemp,
          insideTemp: outsideTemp > 22 ? 23.5 : 21.5,
          climateOn: true,
          elevation: Math.round(34 + 26 * Math.sin(progress * Math.PI * 1.7)),
        }),
      );
    }

    drives.push({
      id: driveId,
      car_id: car.id,
      start_date_at: startAt,
      end_date_at: endAt,
      distance: round(route.km, 2),
      duration_min: route.minutes,
      speed_max: Math.round(speedMax),
      power_max: Math.round(powerMax),
      power_min: Math.round(powerMin),
      start_km: round(startKm, 3),
      end_km: round(endKm, 3),
      outside_temp_avg: outsideTemp,
      inside_temp_avg: outsideTemp > 22 ? 23.5 : 21.5,
      start_ideal_range_km: round(startRange * 1.09, 2),
      end_ideal_range_km: round(endRange * 1.09, 2),
      start_rated_range_km: round(startRange, 2),
      end_rated_range_km: round(endRange, 2),
      start_position_id: firstPositionId,
      end_position_id: positions.length,
      start_address_id: from.addressId,
      end_address_id: to.addressId,
      start_geofence_id: from.geofenceId,
      end_geofence_id: to.geofenceId,
      ...UNCERTAINTY_NONE,
      start_after_at: wakeMin == null ? null : startAt - wakeMin * MINUTE,
      start_before_at: wakeMin == null ? null : startAt,
      origin_reconstructed: wakeMin == null ? 0 : 1,
    });

    odometerKm = endKm;
    soc = endLevel;
    lastActivityAt = endAt;
    setState("asleep", endAt + 22 * MINUTE);
    idleSample(endAt + 30 * MINUTE, to.place, soc - 0.4);
  }

  /**
   * A drive nobody saw: the car went offline before it and came back after,
   * parked somewhere else with the odometer moved. What the logger keeps is the
   * reading either side and a reconstructed drive between them — the distance,
   * both places, no samples and no duration.
   */
  function addHiddenDrive(event, route, from, to) {
    const gapStart = event.at - (event.hidden.beforeMin ?? 60) * MINUTE;
    const gapEnd = event.at + (route.minutes + (event.hidden.afterMin ?? 60)) * MINUTE;
    setState("offline", gapStart + MINUTE);
    const startKm = odometerKm;
    const startPositionId = nextId(positions);
    idleSample(gapStart, from.place, soc);

    const capacity = capacityAt(event.at);
    odometerKm += route.km;
    soc = Math.max(4, soc - ((route.km * car.efficiency * 1.1) / capacity) * 100);
    const endPositionId = nextId(positions);
    idleSample(gapEnd, to.place, soc);

    drives.push({
      id: nextId(drives),
      car_id: car.id,
      start_date_at: gapStart,
      end_date_at: gapEnd,
      distance: round(route.km, 2),
      duration_min: null,
      speed_max: null,
      power_max: null,
      power_min: null,
      start_km: round(startKm, 3),
      end_km: round(odometerKm, 3),
      outside_temp_avg: null,
      inside_temp_avg: null,
      start_ideal_range_km: null,
      end_ideal_range_km: null,
      start_rated_range_km: null,
      end_rated_range_km: null,
      start_position_id: startPositionId,
      end_position_id: endPositionId,
      start_address_id: from.addressId,
      end_address_id: to.addressId,
      start_geofence_id: from.geofenceId,
      end_geofence_id: to.geofenceId,
      ...UNCERTAINTY_NONE,
      ...hiddenSpan(gapStart, gapEnd),
      reconstructed: 1,
      origin_reconstructed: 0,
    });

    lastActivityAt = gapEnd;
    setState("online", gapEnd);
    setState("asleep", gapEnd + 20 * MINUTE);
  }

  /**
   * A charge nobody saw: the same outage, and the state of charge risen across
   * it. Energy and duration are unknown; a per-kWh place still prices it, as a
   * range over what the rise can have taken — what the hidden-event sweep does.
   */
  function addHiddenCharge(event, target, startLevel) {
    const minutes = event.minutes ?? 120;
    const gapStart = event.at - (event.hidden.beforeMin ?? 60) * MINUTE;
    const gapEnd = event.at + (minutes + (event.hidden.afterMin ?? 60)) * MINUTE;
    setState("offline", gapStart + MINUTE);
    const positionId = nextId(positions);
    idleSample(gapStart, target.place, startLevel);
    soc = event.toSoc;
    idleSample(gapEnd, target.place, soc);

    chargingProcesses.push({
      id: nextId(chargingProcesses),
      car_id: car.id,
      start_date_at: gapStart,
      end_date_at: gapEnd,
      charge_energy_added: null,
      charge_energy_used: null,
      duration_min: null,
      start_battery_level: Math.round(startLevel),
      end_battery_level: Math.round(event.toSoc),
      start_ideal_range_km: null,
      end_ideal_range_km: null,
      start_rated_range_km: null,
      end_rated_range_km: null,
      outside_temp_avg: null,
      cost_cents: null,
      position_id: positionId,
      address_id: target.addressId,
      geofence_id: target.geofenceId,
      ...UNCERTAINTY_NONE,
      ...hiddenSpan(gapStart, gapEnd),
      ...UNPRICED(target),
      reconstructed: 1,
    });

    lastActivityAt = gapEnd;
    setState("online", gapEnd);
    setState("asleep", gapEnd + 18 * MINUTE);
  }

  function addCharge(event) {
    const target = placeIds[event.place];
    const startAt = event.at;
    applyIdleDrain(startAt);
    const startLevel = soc;
    if (event.toSoc <= startLevel + 1) return;
    if (event.hidden) return addHiddenCharge(event, target, startLevel);

    const capacity = capacityAt(startAt);
    const energyKwh = ((event.toSoc - startLevel) / 100) * capacity;
    // DC tapers, AC holds its rate; either way derive the duration from it.
    const isDc = event.phases == null;
    const averagePower = isDc ? event.powerKw * 0.62 : event.powerKw * 0.95;
    const minutes = event.minutes ?? Math.max(8, Math.round((energyKwh / averagePower) * 60));
    const endAt = startAt + minutes * MINUTE;
    const outsideTemp = restingTemp(startAt);

    setState("online", startAt - MINUTE);

    const processId = nextId(chargingProcesses);
    const startRange = rangeFor(startAt, startLevel);
    const endRange = rangeFor(endAt, event.toSoc);

    const positionId = nextId(positions);
    idleSample(startAt, target.place, startLevel);

    let peakPower = 0;
    for (let i = 0; i < CHARGE_SAMPLES; i++) {
      const progress = i / (CHARGE_SAMPLES - 1);
      const level = startLevel + (event.toSoc - startLevel) * progress;
      // DC power falls away as the pack fills; AC is flat until the very end.
      const taper = isDc ? Math.max(0.18, 1 - Math.max(0, (level - 35) / 65) ** 1.6) : progress > 0.97 ? 0.4 : 1;
      const power = event.powerKw * taper;
      const at = startAt + minutes * MINUTE * progress;
      peakPower = Math.max(peakPower, power);
      charges.push({
        id: nextId(charges),
        charging_process_id: processId,
        date_at: Math.round(at),
        battery_level: Math.round(level),
        // Equal to the displayed level: a warm pack has nothing capped, and the
        // health endpoint reads usable-below-displayed as a cold pack and drops
        // the session — one seeded point below and no session would ever count.
        usable_battery_level: Math.round(level),
        charge_energy_added: round(energyKwh * progress, 2),
        charger_power: Math.round(power),
        charger_voltage: isDc ? Math.round(360 + level * 0.9) : event.phases === 1 ? 231 : 233,
        charger_actual_current: isDc ? Math.round((power * 1000) / (360 + level * 0.9)) : event.phases === 1 ? 16 : 16,
        charger_phases: event.phases,
        charger_pilot_current: isDc ? null : 16,
        conn_charge_cable: isDc ? "<invalid>" : "IEC",
        fast_charger_present: isDc ? 1 : 0,
        fast_charger_brand: isDc ? "Tesla" : "<invalid>",
        fast_charger_type: isDc ? "Combo" : "<invalid>",
        ideal_battery_range_km: round(rangeFor(at, level) * 1.09, 2),
        rated_battery_range_km: round(rangeFor(at, level), 2),
        not_enough_power_to_heat: 0,
        battery_heater: 0,
        battery_heater_on: 0,
        battery_heater_no_power: 0,
        outside_temp: outsideTemp,
      });
    }

    chargingProcesses.push({
      id: processId,
      car_id: car.id,
      start_date_at: startAt,
      end_date_at: endAt,
      charge_energy_added: round(energyKwh, 2),
      // Charging is lossy: what came out of the wall is more than what landed.
      charge_energy_used: round(energyKwh * (isDc ? 1.06 : 1.11), 2),
      duration_min: minutes,
      start_battery_level: Math.round(startLevel),
      end_battery_level: Math.round(event.toSoc),
      start_ideal_range_km: round(startRange * 1.09, 2),
      end_ideal_range_km: round(endRange * 1.09, 2),
      start_rated_range_km: round(startRange, 2),
      end_rated_range_km: round(endRange, 2),
      outside_temp_avg: outsideTemp,
      cost_cents: null,
      position_id: positionId,
      address_id: target.addressId,
      geofence_id: target.geofenceId,
      ...UNCERTAINTY_NONE,
      ...UNPRICED(target),
    });

    soc = event.toSoc;
    lastActivityAt = endAt;
    setState("asleep", endAt + 18 * MINUTE);
  }

  for (const event of events) {
    if (event.kind === "drive") addDrive(event);
    else if (event.kind === "charge") addCharge(event);
    else if (event.kind === "update") {
      updates.push({
        id: nextId(updates),
        car_id: car.id,
        start_date_at: event.at,
        end_date_at: event.at + 26 * MINUTE,
        version: event.version,
      });
    }
  }

  // Leave the car parked and awake where the live story picks it up.
  const livePlace = world.places[live.place];
  setState("online", now - 4 * MINUTE);
  states.push({
    id: nextId(states),
    car_id: car.id,
    state: stateKind,
    start_date_at: stateOpenedAt,
    end_date_at: null,
  });
  idleSample(now - 3 * MINUTE, livePlace, soc);

  // The tyre history the logger would have kept from those same samples: it
  // reads pressures only from snapshots it fetched anyway, downsampled.
  const sampled = positions
    .filter((p) => p.car_id === car.id)
    .map((p) => p.date_at)
    .sort((a, b) => a - b);
  tables.tyre_readings.push(...tyreReadings({ carId: car.id, times: sampled, readingAt: tyreAt }));

  tables.cars.push({
    id: car.id,
    eid: car.eid,
    vid: car.vid,
    vin: car.vin,
    name: car.name,
    model: car.model,
    trim_badging: car.trimBadging,
    marketing_name: car.marketingName,
    exterior_color: car.exteriorColor,
    wheel_type: car.wheelType,
    spoiler_type: car.spoilerType,
    efficiency: car.efficiency,
    inserted_at: historyStart,
    updated_at: now,
  });
  tables.car_settings.push({
    car_id: car.id,
    enabled: 1,
    suspend_min: 21,
    suspend_after_idle_min: 15,
    ...(car.lfpBattery ? { lfp_battery: 1 } : {}),
  });

  return {
    historyStart,
    manifestCar: {
      ...car,
      schedule: undefined,
      live: undefined,
      odometerKm: round(odometerKm, 1),
      batteryLevel: Math.round(soc),
    },
    manifestLive: {
      ...live,
      lat: livePlace.lat,
      lon: livePlace.lon,
      odometerKm: round(odometerKm, 1),
      batteryLevel: Math.round(soc),
      ratedRangeKm: round(rangeFor(now, soc), 1),
    },
  };
}

/**
 * Build every table the app reads. Returns rows plus a manifest describing the
 * world for the mock API server and the tests.
 */
export function buildDataset({ now = Date.now(), world = e2eWorld() } = {}) {
  const perCarEvents = world.cars.map((car) => expandSchedule(now, car.schedule, world.timezone));
  const historyStart = Math.min(now, ...perCarEvents.flatMap((events) => (events.length > 0 ? [events[0].at] : [])));

  const tables = {
    cars: [],
    car_settings: [],
    addresses: [],
    geofences: [],
    drives: [],
    positions: [],
    charging_processes: [],
    charges: [],
    states: [],
    updates: [],
    tyre_readings: [],
  };

  const placeIds = {};
  for (const [key, place] of Object.entries(world.places)) {
    const addressId = tables.addresses.length + 1;
    tables.addresses.push({
      id: addressId,
      osm_id: 100_000 + addressId,
      osm_type: "way",
      display_name: [
        [place.address.road, place.address.houseNumber].filter(Boolean).join(" "),
        place.address.postcode,
        place.address.city,
        "Germany",
      ]
        .filter(Boolean)
        .join(", "),
      name: place.name,
      house_number: place.address.houseNumber ?? null,
      road: place.address.road ?? null,
      neighbourhood: null,
      city: place.address.city ?? null,
      county: null,
      postcode: place.address.postcode ?? null,
      state: place.address.state ?? "Berlin",
      state_district: null,
      country: "Germany",
      latitude: place.lat,
      longitude: place.lon,
      raw: JSON.stringify({ mock: true, place: key }),
      inserted_at: historyStart,
      updated_at: historyStart,
    });

    let geofenceId = null;
    if (place.fence) {
      geofenceId = tables.geofences.length + 1;
      tables.geofences.push({
        id: geofenceId,
        name: place.name,
        latitude: place.lat,
        longitude: place.lon,
        radius: place.fence.radius,
        billing_type: place.fence.billing,
        cost_per_unit: place.fence.rate,
        session_fee_cents: place.fence.sessionFeeCents ?? null,
        tariff: fenceTariff(place.fence, historyStart, world.timezone),
        charger_power_kw: place.fence.chargerPowerKw ?? null,
        inserted_at: historyStart,
        updated_at: historyStart,
      });
    }
    placeIds[key] = { addressId, geofenceId, place };
  }

  const results = world.cars.map((car, i) =>
    simulateCar({ car, events: perCarEvents[i], world, now, tables, placeIds }),
  );

  return {
    tables,
    settings: {
      timezone: world.timezone,
      unit_of_length: "km",
      unit_of_temperature: "C",
      preferred_range: "rated",
    },
    manifest: {
      generatedAt: now,
      timezone: world.timezone,
      historyStartAt: historyStart,
      // Singular car/live mirror the first car — the e2e mock server and the
      // stories were written against a one-car world and read these directly.
      car: results[0].manifestCar,
      live: results[0].manifestLive,
      cars: results.map((r) => r.manifestCar),
      lives: results.map((r) => r.manifestLive),
      places: Object.fromEntries(
        Object.entries(world.places).map(([key, place]) => [
          key,
          {
            name: place.name,
            lat: place.lat,
            lon: place.lon,
            address: place.address,
            fenced: Boolean(place.fence),
            // OSM category, for the places the mock should answer the POI layer
            // about. Absent means "no point of interest here", which is the
            // honest answer for a stretch of street.
            poi: place.poi ?? null,
          },
        ]),
      ),
      counts: {
        drives: tables.drives.length,
        charges: tables.charging_processes.length,
        positions: tables.positions.length,
        chargeSamples: tables.charges.length,
        geofences: tables.geofences.length,
        addresses: tables.addresses.length,
        tyreReadings: tables.tyre_readings.length,
      },
    },
  };
}
