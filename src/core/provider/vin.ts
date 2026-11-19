/**
 * A VIN as a maker's API takes it in a path: 17 letters and digits, upper
 * case, without I, O or Q. Null when it is not one, so nothing else can be put
 * into a URL where a VIN goes.
 */
export function normalizeVin(vin: string): string | null {
  const v = vin.trim().toUpperCase();
  return /^[A-HJ-NPR-Z0-9]{17}$/.test(v) ? v : null;
}
