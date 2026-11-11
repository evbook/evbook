/** Charge cost rules — port of TeslaMate's log.ex `put_cost/2`. */

export interface GeofenceCostRule {
  billing_type: "per_kwh" | "per_minute";
  cost_per_unit: number | null;
  session_fee_cents: number | null;
}

export interface CostInputs {
  fastChargerType: string | null;
  freeSupercharging: boolean;
  energyAdded: number | null;
  energyUsed: number | null;
  durationMin: number | null;
  geofence: GeofenceCostRule | null;
}

/**
 * Returns the session cost in integer cents, or null when no rule applies.
 * Order matches TeslaMate: free supercharging wins, then the geofence rule.
 */
export function calculateCostCents(input: CostInputs): number | null {
  if (input.freeSupercharging && input.fastChargerType?.startsWith("Tesla")) return 0;

  const geofence = input.geofence;
  if (!geofence) return null;

  const fee = geofence.session_fee_cents;
  const rate = geofence.cost_per_unit;

  if (geofence.billing_type === "per_kwh") {
    const energies = [input.energyAdded, input.energyUsed].filter((n): n is number => n != null);
    if (energies.length === 0) return null;
    const kwh = Math.max(...energies);
    const variable = rate == null ? null : Math.round(kwh * rate * 100);
    if (variable === null && fee === null) return null;
    return (fee ?? 0) + (variable ?? 0);
  }

  // per_minute
  if (input.durationMin == null || rate == null) return fee ?? null;
  return (fee ?? 0) + Math.round(input.durationMin * rate * 100);
}

/** What a session's billed inputs are known only to lie between. */
export interface CostBounds {
  /** Minutes billed by a per-minute tariff, when the ends are spans. */
  durationMin?: { min: number; max: number } | null;
  /** Energy billed by a per-kWh tariff, when it is known only from the state of charge. */
  energyKwh?: { min: number; max: number } | null;
}

/**
 * The cost as a range, for a session whose inputs are bounded rather than
 * measured: the rule applied at each end of each bounded input. `max` equals
 * `min` when nothing is bounded or the tariff ignores what is, so the caller
 * stores a range only when there is one. Null when no rule applies at all.
 *
 * A single price per place is all a geofence holds today, so this is the one
 * place a time-of-use tariff will have to widen: a bounded start that may fall
 * either side of a price change is just another input with two ends.
 */
export function calculateCostRange(input: CostInputs, bounds: CostBounds): { min: number; max: number } | null {
  const at = (pick: "min" | "max"): number | null =>
    calculateCostCents({
      ...input,
      durationMin: bounds.durationMin?.[pick] ?? input.durationMin,
      ...(bounds.energyKwh ? { energyAdded: bounds.energyKwh[pick], energyUsed: null } : {}),
    });
  const lo = at("min");
  const hi = at("max");
  if (lo == null || hi == null) return lo == null && hi == null ? null : { min: lo ?? hi!, max: hi ?? lo! };
  return { min: Math.min(lo, hi), max: Math.max(lo, hi) };
}
