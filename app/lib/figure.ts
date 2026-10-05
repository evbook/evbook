/**
 * A formatted reading split into its number and its unit — "314 km" into "314"
 * and "km" — so the number can be set large and the unit small beside it.
 *
 * Only a single trailing unit is split off. A reading with digits after its first
 * word ("1 h 45 min") is a compound and stays whole: splitting it would set "1"
 * large and leave "h 45 min" to look like a footnote. So does a dash, which is
 * the formatters' word for "no reading".
 */
export function splitUnit(text: string): { value: string; unit: string } {
  const match = /^(-?[\d.,\s]*\d)\s*([^\d\s].*)$/u.exec(text);
  if (!match || /\d/.test(match[2]!)) return { value: text, unit: "" };
  return { value: match[1]!, unit: match[2]! };
}
