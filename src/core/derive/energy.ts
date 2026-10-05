/**
 * Charge-session energy derivations — ports of TeslaMate's log.ex
 * `calculate_energy_used/1` and `determine_phases/1`. Computed in TS rather
 * than SQL because the phase-correction logic is branch-heavy.
 */

export interface ChargeSample {
  date_at: number;
  charger_power: number | null;
  charger_voltage: number | null;
  charger_actual_current: number | null;
  charger_phases: number | null;
  charge_energy_added: number | null;
  fast_charger_type?: string | null;
}

/**
 * Determine the effective phase count. Requires more than 15 samples; compares
 * the power implied by current x voltage against the reported phase count and
 * applies TeslaMate's sqrt(3) voltage correction or integer phase correction.
 * Returns null when inconclusive, which makes energy fall back to charger_power.
 */
export function determinePhases(samples: ChargeSample[]): number | null {
  if (samples.length <= 15) return null;

  let sumRatio = 0;
  let countRatio = 0;
  let sumPhases = 0;
  let countPhases = 0;

  for (const s of samples) {
    const denominator = (s.charger_actual_current ?? 0) * (s.charger_voltage ?? 0);
    if (s.charger_power != null && denominator !== 0) {
      sumRatio += (s.charger_power * 1000) / denominator;
      countRatio++;
    }
    if (s.charger_phases != null) {
      sumPhases += s.charger_phases;
      countPhases++;
    }
  }

  if (countRatio === 0 || countPhases === 0) return null;
  const p = sumRatio / countRatio;
  if (!(p > 0)) return null;
  const reported = Math.round(sumPhases / countPhases);

  if (reported === Math.round(p)) return reported;
  if (reported === 3 && Math.abs(p / Math.sqrt(reported) - 1) <= 0.1) return Math.sqrt(reported);
  if (Math.abs(Math.round(p) - p) <= 0.3) return Math.round(p);
  return null;
}

/**
 * Integrate power over time across the session. Per sample:
 *   (phases == null ? charger_power : current * voltage * phases / 1000) * dt_hours
 * Negative contributions are dropped, as in TeslaMate.
 */
export function calculateEnergyUsed(samples: ChargeSample[]): number | null {
  if (samples.length === 0) return null;
  const ordered = [...samples].sort((a, b) => a.date_at - b.date_at);
  const phases = determinePhases(ordered);

  let total = 0;
  let counted = 0;
  for (let i = 1; i < ordered.length; i++) {
    const cur = ordered[i]!;
    const prev = ordered[i - 1]!;
    const hours = (cur.date_at - prev.date_at) / 3_600_000;
    const power =
      cur.charger_phases == null
        ? (cur.charger_power ?? 0)
        : ((cur.charger_actual_current ?? 0) * (cur.charger_voltage ?? 0) * (phases ?? cur.charger_phases)) / 1000;
    const energy = power * hours;
    if (energy >= 0) {
      total += energy;
      counted++;
    }
  }
  return counted === 0 ? null : round2(total);
}

/**
 * Energy added over the session, resilient to the car's counter resetting to 0
 * mid-session: coalesce(nullif(last, 0), max) - first. Negative results are
 * treated as unknown, and so is a counter that never left zero: a session where
 * nothing ever reported energy is one nobody measured, which is a different
 * claim from measuring nothing — and a source that cannot see the pack (a
 * Tessie export whose pack file has a gap) makes exactly that distinction.
 */
export function calculateEnergyAdded(samples: ChargeSample[]): number | null {
  if (samples.length === 0) return null;
  const ordered = [...samples].sort((a, b) => a.date_at - b.date_at);
  const values = ordered.map((s) => s.charge_energy_added).filter((n): n is number => n != null);
  if (values.length === 0) return null;
  const first = values[0]!;
  const last = values[values.length - 1]!;
  const max = Math.max(...values);
  const end = last === 0 ? max : last;
  if (end === 0) return null;
  const added = end - first;
  return added < 0 ? null : round2(added);
}

/** Statistical mode of fast_charger_type over samples drawing power. */
export function modalFastChargerType(samples: ChargeSample[]): string | null {
  const counts = new Map<string, number>();
  for (const s of samples) {
    if ((s.charger_power ?? 0) > 0 && s.fast_charger_type) {
      counts.set(s.fast_charger_type, (counts.get(s.fast_charger_type) ?? 0) + 1);
    }
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [type, count] of counts) {
    if (count > bestCount) {
      best = type;
      bestCount = count;
    }
  }
  return best;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
