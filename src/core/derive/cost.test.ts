import { describe, expect, it } from "bun:test";
import type { TariffPriceDto, TariffWindowDto } from "@shared/api-types";
import { priceCharge, type ChargeForPricing, type PlacePricing } from "./cost";

const BERLIN = "Europe/Berlin";
const MIN = 60_000;
const H = 60 * MIN;
const ALL_DAYS = [1, 2, 3, 4, 5, 6, 7];

/** 20:00 local on Wednesday 1 July 2026 (UTC+2). */
const EVENING = Date.UTC(2026, 6, 1, 18);

function night(rate = 0.1, extra: Partial<TariffWindowDto> = {}): TariffWindowDto {
  return { label: "Night", days: ALL_DAYS, start: "22:00", end: "06:00", months: null, rate, ...extra };
}

function place(prices: Partial<TariffPriceDto>[], extra: Partial<PlacePricing> = {}): PlacePricing {
  return {
    tariff: prices.map((p) => ({
      validFrom: "2026-01-01",
      billingType: "per_kwh",
      rate: 0.3,
      sessionFeeCents: null,
      windows: [],
      ...p,
    })),
    timeZone: BERLIN,
    chargerPowerKw: null,
    acEfficiency: null,
    dcEfficiency: null,
    ...extra,
  };
}

/** Evenly spaced samples at constant power from `from` to `to`. */
function steady(from: number, to: number, powerKw: number, every = MIN) {
  const samples = [];
  for (let at = from; at <= to; at += every) samples.push({ at, powerKw });
  return samples;
}

function charge(extra: Partial<ChargeForPricing> = {}): ChargeForPricing {
  return {
    startAt: EVENING,
    endAt: EVENING + 4 * H,
    startAfter: null,
    startBefore: null,
    endAfter: null,
    endBefore: null,
    energyAdded: 40,
    energyUsed: 42,
    energyRange: null,
    reconstructed: false,
    dc: false,
    samples: steady(EVENING, EVENING + 4 * H, 10.5),
    fastChargerType: null,
    freeSupercharging: false,
    carAcLimitKw: 11.5,
    ...extra,
  };
}

describe("a flat price, as migrated", () => {
  it("bills the greater of added and drawn per kWh, plus the fee — as before tariffs", () => {
    const cost = priceCharge(charge(), place([{ sessionFeeCents: 100 }]));
    // 42 kWh * 0.30 = 12.60 plus a 1.00 session fee.
    expect(cost).toMatchObject({ min: 1360, max: 1360 });
    expect(cost!.detail).toMatchObject({ estimated: false, billedKwh: { min: 42, max: 42 } });
  });

  it("bills whole minutes per minute", () => {
    const cost = priceCharge(
      charge({ samples: steady(EVENING, EVENING + 30 * MIN, 11) }),
      place([{ billingType: "per_minute", rate: 0.1 }]),
    );
    expect(cost).toMatchObject({ min: 300, max: 300 });
  });

  it("still applies a session fee when the rate is nothing", () => {
    expect(priceCharge(charge(), place([{ rate: 0, sessionFeeCents: 250 }]))).toMatchObject({ min: 250, max: 250 });
  });

  it("is free at a Tesla supercharger with free supercharging, whatever the place", () => {
    const free = charge({ fastChargerType: "Tesla", freeSupercharging: true, dc: true });
    expect(priceCharge(free, null)).toMatchObject({ min: 0, max: 0, detail: { free: true } });
    expect(priceCharge(free, place([{ rate: 0.6 }]))).toMatchObject({ min: 0, max: 0 });
  });

  it("is unknown without a place, a tariff, or any energy", () => {
    expect(priceCharge(charge(), null)).toBeNull();
    expect(priceCharge(charge(), place([]))).toBeNull();
    expect(priceCharge(charge({ energyAdded: null, energyUsed: null }), place([{}]))).toBeNull();
  });

  it("leaves a session before the tariff's first local day unpriced", () => {
    // 23:30 local on 31 December 2025 is still the old year in Berlin, though
    // 2026 has begun in UTC+14.
    const lastNight = Date.UTC(2025, 11, 31, 22, 30);
    const early = charge({ startAt: lastNight, endAt: lastNight + H, samples: steady(lastNight, lastNight + H, 11) });
    expect(priceCharge(early, place([{}]))).toBeNull();
    expect(priceCharge(early, place([{}], { timeZone: "Pacific/Kiritimati" }))).not.toBeNull();
  });

  it("uses the price in force on the day the session began", () => {
    const tariff = place([{ rate: 0.3 }, { validFrom: "2026-07-01", rate: 0.4 }]);
    expect(priceCharge(charge({ energyUsed: 10, energyAdded: 9 }), tariff)).toMatchObject({ min: 400 });
    const june = EVENING - 24 * H;
    expect(
      priceCharge(
        charge({ energyUsed: 10, energyAdded: 9, startAt: june, samples: steady(june, june + H, 10) }),
        tariff,
      ),
    ).toMatchObject({ min: 300 });
  });
});

describe("time-of-use per kWh", () => {
  const offPeak = place([{ rate: 0.3, windows: [night(0.1)] }]);

  it("places energy where the samples say it flowed", () => {
    // 20:00–24:00 local at a steady 10.5 kW: half before 22:00, half after.
    const cost = priceCharge(charge(), offPeak)!;
    // 21 kWh at 0.30 + 21 kWh at 0.10 = 8.40.
    expect(cost.min).toBe(840);
    expect(cost.max).toBe(840);
    expect(cost.detail.parts).toEqual([
      { label: null, window: -1, rate: 0.3, min: 21, max: 21 },
      { label: "Night", window: 0, rate: 0.1, min: 21, max: 21 },
    ]);
  });

  it("weights by power: a session that slows down puts less in its later hours", () => {
    const samples = [...steady(EVENING, EVENING + 2 * H, 11), ...steady(EVENING + 2 * H + MIN, EVENING + 4 * H, 3)];
    const cost = priceCharge(charge({ samples }), offPeak)!;
    expect(cost.detail.parts[0]!.min).toBeGreaterThan(cost.detail.parts[1]!.min * 3);
  });

  it("ranges over a gap in the samples, as far as the onboard charger allows", () => {
    // Samples until 21:00, then nothing until 01:00: the energy in between may
    // have flowed at any time, at up to 11.5 kW.
    const samples = [...steady(EVENING, EVENING + H, 10), { at: EVENING + 5 * H, powerKw: 10 }];
    const cost = priceCharge(charge({ samples, endAt: EVENING + 5 * H }), offPeak)!;
    expect(cost.min).toBeLessThan(cost.max);
    // The gap holds 40 of the 50 kWh-weight: 4 h of 10 kW. Cheapest: all after
    // 22:00 (3 h at ≤ 11.5 kW = 34.5 kWh) and the rest before; dearest: the
    // first hour (21:00–22:00) full at 11.5 kW, the rest at night.
    const gapKwh = 42 * (40 / 50);
    const knownKwh = 42 - gapKwh;
    const cheapest = knownKwh * 0.3 + Math.max(0, gapKwh - 34.5) * 0.3 + Math.min(gapKwh, 34.5) * 0.1;
    const dearest = knownKwh * 0.3 + Math.min(gapKwh, 11.5) * 0.3 + Math.max(0, gapKwh - 11.5) * 0.1;
    expect(cost.min).toBe(Math.round(cheapest * 100));
    expect(cost.max).toBe(Math.round(dearest * 100));
  });

  it("narrows the range with the place's charger power", () => {
    const samples = [...steady(EVENING, EVENING + H, 10), { at: EVENING + 5 * H, powerKw: 10 }];
    const wide = priceCharge(charge({ samples, dc: true }), offPeak)!;
    const narrow = priceCharge(charge({ samples, dc: true }), { ...offPeak, chargerPowerKw: 7.4 })!;
    expect(narrow.max - narrow.min).toBeLessThan(wide.max - wide.min);
  });

  it("puts unplaced DC energy anywhere, unless the place caps it", () => {
    const unsampled = charge({ samples: [], dc: true, startAt: EVENING, endAt: EVENING + 4 * H });
    const cost = priceCharge(unsampled, offPeak)!;
    expect(cost).toMatchObject({ min: 420, max: 1260 });
  });

  it("estimates grid energy from battery energy and the efficiency when the car did not report it", () => {
    const cost = priceCharge(charge({ energyUsed: null, energyAdded: 44 }), place([{ rate: 0.3 }]))!;
    expect(cost.detail).toMatchObject({ estimated: true, efficiency: 0.88, billedKwh: { min: 50, max: 50 } });
    expect(cost.min).toBe(1500);
    const dc = priceCharge(charge({ energyUsed: null, energyAdded: 47.5, dc: true }), place([{ rate: 0.3 }]))!;
    expect(dc.detail.billedKwh).toEqual({ min: 50, max: 50 });
    const own = priceCharge(
      charge({ energyUsed: null, energyAdded: 45 }),
      place([{ rate: 0.3 }], { acEfficiency: 0.9 }),
    )!;
    expect(own.min).toBe(1500);
  });

  it("ranges a charge nobody saw over its state-of-charge energy and the whole gap", () => {
    const gapStart = EVENING + 90 * MIN; // 21:30
    const gapEnd = gapStart + 9 * H; // 06:30
    const hidden = charge({
      reconstructed: true,
      dc: null,
      samples: [],
      energyAdded: null,
      energyUsed: null,
      energyRange: { min: 19, max: 21 },
      startAt: gapStart,
      endAt: gapEnd,
      startAfter: gapStart,
      startBefore: gapEnd,
      endAfter: gapStart,
      endBefore: gapEnd,
    });
    const cost = priceCharge(hidden, offPeak)!;
    // Cheapest: the least energy at the best efficiency, all at night.
    expect(cost.min).toBe(Math.round((19 / 0.95) * 0.1 * 100));
    // Dearest: the most at the worst efficiency, the day's hour first at
    // whatever rate (current unknown, so no onboard cap), the rest at night.
    expect(cost.max).toBe(Math.round((21 / 0.88) * 0.3 * 100));
    // With the charger's 11 kW known, an hour of day rate holds at most 11 kWh.
    const capped = priceCharge(hidden, { ...offPeak, chargerPowerKw: 11 })!;
    expect(capped.max).toBe(Math.round((11 * 0.3 + (21 / 0.88 - 11) * 0.1) * 100));
    expect(capped.detail.estimated).toBe(true);
  });

  it("bills a December-only window only in December", () => {
    const winter = place([{ rate: 0.3, windows: [night(0.1, { months: [12] })] }]);
    expect(priceCharge(charge(), winter)!.min).toBe(1260);
    const december = Date.UTC(2026, 11, 2, 19);
    const decCharge = charge({ startAt: december, samples: steady(december, december + 4 * H, 10.5) });
    expect(priceCharge(decCharge, winter)!.min).toBe(840);
  });
});

describe("time-of-use per minute", () => {
  const offPeak = place([{ billingType: "per_minute", rate: 0.05, sessionFeeCents: 50, windows: [night(0.01)] }]);

  it("bills each minute at its own rate", () => {
    const cost = priceCharge(charge(), offPeak)!;
    // 120 min at 0.05 + 120 min at 0.01 + fee.
    expect(cost).toMatchObject({ min: 770, max: 770 });
  });

  it("ranges over bounded ends: the shortest session the evidence allows to the longest", () => {
    const cost = priceCharge(charge({ startAfter: EVENING - 30 * MIN, endBefore: EVENING + 5 * H }), offPeak)!;
    expect(cost.min).toBe(770);
    // Plus 30 day minutes before and 60 night minutes after.
    expect(cost.max).toBe(770 + 150 + 60);
  });

  it("says nothing of a charge nobody saw: how long it took is not known", () => {
    expect(priceCharge(charge({ reconstructed: true, samples: [] }), offPeak)).toBeNull();
  });
});
