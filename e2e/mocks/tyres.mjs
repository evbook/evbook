/**
 * Tyre pressures for the generated worlds (e2e and demo), and the warnings the
 * mock Tesla API raises for them. One model, so the seeded history and the live
 * snapshot the mock serves agree about the same tyre.
 *
 * A tyre's pressure here is what physics and an owner make of it:
 *   - filled to a set pressure every `fillEveryDays`, the last fill
 *     `lastFillDaysAgo` before now (so the present is anchored, whatever "now"
 *     the world is generated at);
 *   - drifting with the outside temperature from the fill on — about 0.01 bar
 *     per °C, which is the seasonal swing a year of history shows;
 *   - losing a little through the rubber every day;
 *   - and, for one tyre, a slow leak that started `leak.startDaysAgo` ago and
 *     has taken `leak.totalBar` off it by now.
 *
 * Each tyre is anchored so that at `now` it reads exactly `live.tyrePressureBar`,
 * which is what the mock API reports and what the stories assert.
 */

const DAY = 86_400_000;
const BAR_PER_C = 0.01;
const LOSS_BAR_PER_DAY = 0.0015;
const CORNERS = ["fl", "fr", "rl", "rr"];

/** Tesla's soft and hard TPMS warnings, as the mock car raises them. */
export function tyreWarnings(bar, recommended) {
  if (bar == null || recommended == null) return { soft: null, hard: null };
  return { soft: bar < recommended * 0.85, hard: bar < recommended * 0.75 };
}

export const DEFAULT_TYRES = {
  recommendedBar: { front: 2.9, rear: 2.9 },
  fillEveryDays: 90,
  lastFillDaysAgo: 20,
  leak: null,
};

/**
 * `tempAt(at)` is the outside temperature the world uses. Returns `at => reading`
 * with the four pressures (bar, 3 decimals), the axle recommendations and the
 * warnings, in `tyre_readings` column names.
 */
export function tyreModel({ car, live, now, tempAt: exactTempAt }) {
  const tyres = { ...DEFAULT_TYRES, ...car.tyres };
  // The world's temperature is a time-zone-aware sine, costly per call and
  // called for every sample of a multi-year history: a quarter-hour grid is
  // finer than a tyre follows the weather anyway.
  const STEP = 15 * 60_000;
  const temps = new Map();
  const tempAt = (at) => {
    const slot = Math.round(at / STEP);
    let t = temps.get(slot);
    if (t === undefined) temps.set(slot, (t = exactTempAt(slot * STEP)));
    return t;
  };
  const every = tyres.fillEveryDays * DAY;
  const lastFill = now - tyres.lastFillDaysAgo * DAY;
  const fillBefore = (at) => lastFill - Math.ceil(Math.max(0, lastFill - at) / every) * every;
  const leakAt = (corner, at) => {
    const leak = tyres.leak;
    if (!leak || leak.corner !== corner) return 0;
    const start = now - leak.startDaysAgo * DAY;
    if (at <= start) return 0;
    return (leak.totalBar * Math.min(at - start, now - start)) / (now - start);
  };
  const drift = (at, fill) => BAR_PER_C * (tempAt(at) - tempAt(fill)) - (LOSS_BAR_PER_DAY * (at - fill)) / DAY;

  // The pressure each tyre is filled to, solved so the present reads `live`.
  const fillBar = Object.fromEntries(
    CORNERS.map((c) => [c, live.tyrePressureBar[c] - drift(now, lastFill) + leakAt(c, now)]),
  );

  return (at) => {
    const fill = fillBefore(at);
    const moved = drift(at, fill);
    const row = {};
    for (const c of CORNERS) {
      row[`pressure_${c}`] = Math.round((fillBar[c] + moved - leakAt(c, at)) * 1000) / 1000;
    }
    row.recommended_front = tyres.recommendedBar.front;
    row.recommended_rear = tyres.recommendedBar.rear;
    for (const c of CORNERS) {
      const w = tyreWarnings(row[`pressure_${c}`], c[0] === "f" ? row.recommended_front : row.recommended_rear);
      row[`soft_warning_${c}`] = w.soft ? 1 : 0;
      row[`hard_warning_${c}`] = w.hard ? 1 : 0;
    }
    return row;
  };
}

/**
 * The logger's downsampling, applied to a car's samples: one row per 15 minutes
 * of readings, plus one whenever a warning changes. `times` must be sorted.
 */
export function tyreReadings({ carId, times, readingAt }) {
  const rows = [];
  let last = null;
  for (const at of times) {
    const reading = readingAt(at);
    const flags = CORNERS.map((c) => `${reading[`soft_warning_${c}`]}${reading[`hard_warning_${c}`]}`).join("");
    if (last && at - last.at < 15 * 60_000 && flags === last.flags) continue;
    if (last && at === last.at) continue;
    rows.push({ car_id: carId, date_at: at, ...reading });
    last = { at, flags };
  }
  return rows;
}
