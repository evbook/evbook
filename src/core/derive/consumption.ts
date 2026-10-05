/**
 * Consumption per 100 km, and the distance below which the figure means nothing.
 *
 * Energy used is a range delta times the car's efficiency, so it counts every
 * watt the pack gave up while the drive was open — standby, HVAC, the BMS
 * revising its own estimate — not just the watts that turned the wheels. Over
 * any real journey those are a rounding error. Over a metre they are the whole
 * number: a drive of 17 m that sat awake for a minute lost 0.11 km of range,
 * which divides out to 103 kWh/100 km. That is a correct division and a useless
 * statistic, and it is a third of the drives ever logged, because a car shunted
 * in and out of a driveway logs a drive each time.
 *
 * So the ratio is only reported once there is enough distance underneath it to
 * outweigh what the car spends standing still. Measured against the archive, the
 * figure settles at about a kilometre and is firm past two; below a kilometre a
 * third of drives come out above 40 kWh/100 km or with the range going up. The
 * energy and the distance are still reported on their own — those are honest.
 */

/** Below this, consumption is reported as unknown rather than as a number. */
export const MIN_CONSUMPTION_DISTANCE_KM = 1;

/**
 * kWh per 100 km, or null when the distance is too short to divide by. Applies to
 * a single drive and to any total, since a window holding nothing but one shunt
 * up the driveway is as thin a denominator as the shunt itself.
 */
export function consumptionPer100km(energyKwh: number | null, distanceKm: number | null): number | null {
  if (energyKwh == null || distanceKm == null || distanceKm < MIN_CONSUMPTION_DISTANCE_KM) return null;
  return (energyKwh / distanceKm) * 100;
}

/**
 * The same floor as a SQL guard, for the sort, the filter and the slider bounds —
 * a value the list will not show must not order it or set the extent of its
 * handles either. `energy` is the range-delta expression for the chosen range
 * kind; `distance` the drive's distance column.
 */
export function consumptionSql(energy: string, distance: string): string {
  return `(CASE WHEN ${distance} >= ${MIN_CONSUMPTION_DISTANCE_KM} THEN ${energy} / ${distance} * 100 END)`;
}
