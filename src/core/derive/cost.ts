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
