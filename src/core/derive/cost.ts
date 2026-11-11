/**
 * What a charging session cost under its place's tariff, as a range.
 *
 * A session is billed on grid energy (per kWh) or on time plugged in (per
 * minute), each stretch at the rate in force then. Neither is fully known:
 * a poller sees the session in samples, its ends only as spans, and a session
 * nobody saw only as a state-of-charge rise. So the answer is the cheapest and
 * the dearest bill the evidence allows, and both are the same number whenever
 * the evidence pins it down.
 *
 * Per kWh, the steps are:
 *
 * 1. The grid energy. A car that reports what it drew (`charge_energy_used`,
 *    integrated from the charger's own power readings) is taken at its word,
 *    as TeslaMate always did: the greater of added and drawn. Otherwise it is
 *    the battery energy divided by the charging efficiency — the place's, else
 *    88% AC / 95% DC — and marked an estimate.
 * 2. Where it went in time. Between two samples the energy is what their
 *    average power says, spread evenly in time across the interval: samples a
 *    minute or two apart leave nothing to choose. An interval longer than
 *    MAX_SAMPLE_GAP_MS, or a session with no power readings at all, is
 *    *flexible*: its energy may have flowed at any moment of it, as fast as the
 *    power cap allows (the place's charger, the car's onboard charger on AC,
 *    unbounded on DC unless the place says).
 * 3. The bill. Fixed energy is priced where it fell. Flexible energy is
 *    priced twice — once poured into the cheapest moments first, once into the
 *    dearest — which are exactly the lowest and highest bills any placement
 *    within the cap could produce, because each moment can take at most
 *    cap × duration and the rates are fixed.
 *
 * Per minute, the session is billed from start to end at each moment's rate.
 * A bounded start or end widens it: the cheapest bill is the shortest the
 * evidence allows, the dearest the longest.
 *
 * Free supercharging beats every tariff, as in TeslaMate's `put_cost/2`.
 */

import type { CostDetailDto, CostPartDto, NumberRange, TariffPriceDto } from "@shared/api-types";
import { BASE, priceOn, rateSlices, type RateSlice } from "../tariff";
import { localDate } from "../zone";

/** Default share of grid energy that reaches the battery. */
export const DEFAULT_AC_EFFICIENCY = 0.88;
export const DEFAULT_DC_EFFICIENCY = 0.95;

/**
 * Samples further apart than this no longer say when the energy between them
 * flowed — the logger was napping, not watching a steady charge.
 */
export const MAX_SAMPLE_GAP_MS = 15 * 60_000;

/** What a place's settings say about pricing a session there. */
export interface PlacePricing {
  tariff: TariffPriceDto[];
  timeZone: string;
  chargerPowerKw: number | null;
  acEfficiency: number | null;
  dcEfficiency: number | null;
}

export interface ChargeForPricing {
  /** Best estimates of the ends, as stored. */
  startAt: number;
  endAt: number;
  /** The ends' spans (core/uncertainty): null means exactly startAt / endAt. */
  startAfter: number | null;
  startBefore: number | null;
  endAfter: number | null;
  endBefore: number | null;
  energyAdded: number | null;
  energyUsed: number | null;
  /** Battery-side energy known only as a range — a session nobody saw. */
  energyRange: NumberRange | null;
  reconstructed: boolean;
  /** true DC, false AC, null not known. */
  dc: boolean | null;
  /** Ordered samples; power in kW. */
  samples: { at: number; powerKw: number | null }[];
  fastChargerType: string | null;
  freeSupercharging: boolean;
  /** The car's onboard charger limit, kW: caps AC. Null: unknown. */
  carAcLimitKw: number | null;
}

export interface PricedCost {
  min: number;
  max: number;
  detail: CostDetailDto;
}

const FREE: PricedCost = {
  min: 0,
  max: 0,
  detail: {
    free: true,
    priceFrom: null,
    billingType: null,
    billedKwh: null,
    estimated: false,
    efficiency: null,
    sessionFeeCents: null,
    parts: [],
  },
};

/** The session's cost under its place's tariff, or null when nothing prices it. */
export function priceCharge(charge: ChargeForPricing, place: PlacePricing | null): PricedCost | null {
  if (charge.freeSupercharging && charge.fastChargerType?.startsWith("Tesla")) return FREE;
  if (!place || place.tariff.length === 0) return null;
  // The price in force on the day the session began, in the place's zone. A
  // session before the tariff's first day stays unpriced.
  const price = priceOn(place.tariff, localDate(charge.startAt, place.timeZone));
  if (!price) return null;
  return price.billingType === "per_kwh" ? perKwh(charge, place, price) : perMinute(charge, place, price);
}

interface Segment {
  from: number;
  to: number;
  /** Share of the session's energy, 0–1. */
  share: number;
  flexible: boolean;
}

/** The energy's whereabouts in time, as shares of the whole. */
function segments(charge: ChargeForPricing): Segment[] {
  const samples = charge.samples;
  const weights: Segment[] = [];
  let total = 0;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1]!;
    const b = samples[i]!;
    if (b.at <= a.at) continue;
    const power = (Math.max(0, a.powerKw ?? 0) + Math.max(0, b.powerKw ?? 0)) / 2;
    const energy = (power * (b.at - a.at)) / 3_600_000;
    if (energy <= 0) continue;
    weights.push({ from: a.at, to: b.at, share: energy, flexible: b.at - a.at > MAX_SAMPLE_GAP_MS });
    total += energy;
  }
  if (total > 0) return weights.map((w) => ({ ...w, share: w.share / total }));

  // Nothing says when it flowed: anywhere between the earliest the session
  // can have started and the latest it can have ended.
  const from = Math.min(charge.startAfter ?? charge.startAt, charge.startAt);
  const to = Math.max(charge.endBefore ?? charge.endAt, charge.endAt, from);
  return [{ from, to, share: 1, flexible: true }];
}

function capKw(charge: ChargeForPricing, place: PlacePricing): number {
  const charger = place.chargerPowerKw ?? Infinity;
  if (charge.dc === false) return Math.min(charger, charge.carAcLimitKw ?? Infinity);
  return charger;
}

function efficiencyRange(charge: ChargeForPricing, place: PlacePricing): { lo: number; hi: number } {
  const ac = place.acEfficiency ?? DEFAULT_AC_EFFICIENCY;
  const dc = place.dcEfficiency ?? DEFAULT_DC_EFFICIENCY;
  if (charge.dc === true) return { lo: dc, hi: dc };
  if (charge.dc === false) return { lo: ac, hi: ac };
  return { lo: Math.min(ac, dc), hi: Math.max(ac, dc) };
}

/** Per-window quantities (kWh or minutes) for one placement. */
type Placement = Map<number, number>;

function add(placement: Placement, window: number, quantity: number): void {
  if (quantity > 0) placement.set(window, (placement.get(window) ?? 0) + quantity);
}

/**
 * Pours `energy` kWh into slices, cheapest first (or dearest first), each
 * slice taking at most cap × its duration. When the cap cannot hold it all
 * (the cap is wrong, or the bounds are), the energy is spread evenly in time.
 */
function pour(slices: RateSlice[], energy: number, cap: number, order: "cheap" | "dear", into: Placement): void {
  const capacity = (s: RateSlice) => (cap * (s.to - s.from)) / 3_600_000;
  const room = slices.reduce((sum, s) => sum + capacity(s), 0);
  if (!(room >= energy)) {
    spread(slices, energy, into);
    return;
  }
  const ordered = [...slices].sort((a, b) => (order === "cheap" ? a.rate - b.rate : b.rate - a.rate));
  let left = energy;
  for (const slice of ordered) {
    if (left <= 0) break;
    const take = Math.min(left, capacity(slice));
    add(into, slice.window, take);
    left -= take;
  }
}

function spread(slices: RateSlice[], quantity: number, into: Placement): void {
  const span = slices.reduce((sum, s) => sum + (s.to - s.from), 0);
  if (span <= 0) return;
  for (const slice of slices) add(into, slice.window, (quantity * (slice.to - slice.from)) / span);
}

function bill(price: TariffPriceDto, placement: Placement): number {
  let total = 0;
  for (const [window, quantity] of placement)
    total += quantity * (window === BASE ? price.rate : price.windows[window]!.rate);
  return Math.round(total * 100) + (price.sessionFeeCents ?? 0);
}

function parts(price: TariffPriceDto, low: Placement, high: Placement): CostPartDto[] {
  const windows = [...new Set([...low.keys(), ...high.keys()])].sort((a, b) => a - b);
  return windows.map((window) => {
    const a = low.get(window) ?? 0;
    const b = high.get(window) ?? 0;
    return {
      label: window === BASE ? null : price.windows[window]!.label,
      window,
      rate: window === BASE ? price.rate : price.windows[window]!.rate,
      min: round3(Math.min(a, b)),
      max: round3(Math.max(a, b)),
    };
  });
}

function perKwh(charge: ChargeForPricing, place: PlacePricing, price: TariffPriceDto): PricedCost | null {
  let billed: NumberRange;
  let estimated = true;
  let efficiency: number | null = null;
  const eff = efficiencyRange(charge, place);
  if (charge.energyRange) {
    billed = { min: charge.energyRange.min / eff.hi, max: charge.energyRange.max / eff.lo };
    efficiency = eff.lo === eff.hi ? eff.lo : null;
  } else if (charge.energyUsed != null) {
    const kwh = Math.max(charge.energyAdded ?? 0, charge.energyUsed);
    billed = { min: kwh, max: kwh };
    estimated = false;
  } else if (charge.energyAdded != null) {
    billed = { min: charge.energyAdded / eff.hi, max: charge.energyAdded / eff.lo };
    efficiency = eff.lo === eff.hi ? eff.lo : null;
  } else {
    return null;
  }

  const cap = capKw(charge, place);
  const low: Placement = new Map();
  const high: Placement = new Map();
  for (const segment of segments(charge)) {
    const slices = rateSlices(price, place.timeZone, segment.from, Math.max(segment.to, segment.from + 1));
    const lowKwh = billed.min * segment.share;
    const highKwh = billed.max * segment.share;
    if (segment.flexible) {
      pour(slices, lowKwh, cap, "cheap", low);
      pour(slices, highKwh, cap, "dear", high);
    } else {
      spread(slices, lowKwh, low);
      spread(slices, highKwh, high);
    }
  }

  const a = bill(price, low);
  const b = bill(price, high);
  return {
    min: Math.min(a, b),
    max: Math.max(a, b),
    detail: {
      free: false,
      priceFrom: price.validFrom,
      billingType: "per_kwh",
      billedKwh: { min: round3(billed.min), max: round3(billed.max) },
      estimated,
      efficiency,
      sessionFeeCents: price.sessionFeeCents,
      parts: parts(price, low, high),
    },
  };
}

function perMinute(charge: ChargeForPricing, place: PlacePricing, price: TariffPriceDto): PricedCost | null {
  // How long a session nobody saw lasted is not known at all, so a per-minute
  // price says nothing — not "just the session fee".
  if (charge.reconstructed && (price.rate > 0 || price.windows.some((w) => w.rate > 0))) return null;

  const first = charge.samples[0]?.at;
  const last = charge.samples[charge.samples.length - 1]?.at;
  // Shortest: what the samples span (or the ends' latest start and earliest
  // end); longest: from the earliest start to the latest end.
  const shortFrom = first ?? charge.startBefore ?? charge.startAt;
  const shortTo = Math.max(last ?? charge.endAfter ?? charge.endAt, shortFrom);
  const longFrom = Math.min(charge.startAfter ?? first ?? charge.startAt, shortFrom);
  const longTo = Math.max(charge.endBefore ?? last ?? charge.endAt, shortTo);

  const minutes = (from: number, to: number): Placement => {
    const placement: Placement = new Map();
    const slices = rateSlices(price, place.timeZone, from, to);
    // Whole minutes, as TeslaMate billed: the total is rounded, then shared
    // out between the rates in proportion to their time.
    const total = Math.round((to - from) / 60_000);
    spread(slices, total, placement);
    return placement;
  };
  const low = minutes(shortFrom, shortTo);
  const high = minutes(longFrom, longTo);
  const a = bill(price, low);
  const b = bill(price, high);
  return {
    min: Math.min(a, b),
    max: Math.max(a, b),
    detail: {
      free: false,
      priceFrom: price.validFrom,
      billingType: "per_minute",
      billedKwh: null,
      estimated: false,
      efficiency: null,
      sessionFeeCents: price.sessionFeeCents,
      parts: parts(price, low, high),
    },
  };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
