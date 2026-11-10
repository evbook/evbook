/**
 * Streaming CSV reading for the import pipeline. Deliberately dependency-free
 * and portable: the same code runs under Node (CLI) and workerd (a Worker
 * reading an export out of R2).
 *
 * Exports are large — a Tessie zip unpacks to well over 100 MB of CSV — so
 * nothing here ever holds a whole file in memory.
 */

/** Decodes a byte stream into lines, without line terminators. */
export async function* linesFromChunks(chunks: AsyncIterable<Uint8Array>): AsyncIterable<string> {
  const decoder = new TextDecoder();
  let rest = "";
  for await (const chunk of chunks) {
    rest += decoder.decode(chunk, { stream: true });
    let start = 0;
    for (;;) {
      const nl = rest.indexOf("\n", start);
      if (nl === -1) break;
      const end = nl > start && rest.charCodeAt(nl - 1) === 13 ? nl - 1 : nl;
      yield rest.slice(start, end);
      start = nl + 1;
    }
    rest = rest.slice(start);
  }
  rest += decoder.decode();
  if (rest.length > 0) yield rest.charCodeAt(rest.length - 1) === 13 ? rest.slice(0, -1) : rest;
}

/**
 * Fast path for the shape vendor exports actually use: every field either
 * empty, plain, or wrapped in quotes with nothing quoted inside. Returns null
 * when the line needs the full parser (embedded comma, quote or newline).
 */
function splitSimple(line: string): string[] | null {
  const parts = line.split(",");
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (part.length === 0) continue;
    const first = part.indexOf('"');
    if (first === -1) continue;
    if (first !== 0 || part.length < 2 || part.charCodeAt(part.length - 1) !== 34) return null;
    if (part.indexOf('"', 1) !== part.length - 1) return null;
    parts[i] = part.slice(1, -1);
  }
  return parts;
}

/**
 * Yields one array of fields per record. Handles quoted fields, doubled quotes
 * and newlines inside quotes; blank lines are skipped. The returned array is a
 * fresh array per record, so callers may keep it.
 */
export async function* parseCsv(lines: AsyncIterable<string>): AsyncIterable<string[]> {
  let fields: string[] = [];
  let value = "";
  let quoted = false;

  for await (const line of lines) {
    if (!quoted) {
      const simple = splitSimple(line);
      if (simple !== null) {
        if (simple.length === 1 && simple[0] === "") continue; // blank line
        yield simple;
        continue;
      }
    } else {
      value += "\n"; // the record continues inside a quoted field
    }

    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!;
      if (quoted) {
        if (ch !== '"') {
          value += ch;
        } else if (line[i + 1] === '"') {
          value += '"';
          i++;
        } else {
          quoted = false;
        }
        continue;
      }
      if (ch === '"' && value === "") quoted = true;
      else if (ch === ",") {
        fields.push(value);
        value = "";
      } else value += ch;
    }

    if (quoted) continue;
    fields.push(value);
    const record = fields;
    fields = [];
    value = "";
    if (record.length === 1 && record[0] === "") continue;
    yield record;
  }

  if (fields.length > 0 || value !== "") {
    fields.push(value);
    yield fields;
  }
}

/**
 * Column lookup over a header row. Names are matched case-insensitively on the
 * part before the unit parenthetical, so `Odometer (mi)` and `Odometer (km)`
 * both answer to `odometer` and the unit is available separately.
 */
export class CsvHeader {
  private byName = new Map<string, number>();

  constructor(readonly columns: string[]) {
    for (const [index, column] of columns.entries()) {
      this.byName.set(bareName(column), index);
    }
  }

  /** Index of the first matching column, or -1. */
  index(...names: string[]): number {
    for (const name of names) {
      const found = this.byName.get(bareName(name));
      if (found !== undefined) return found;
    }
    return -1;
  }

  has(...names: string[]): boolean {
    return this.index(...names) !== -1;
  }

  /** Lower-cased unit as written in the header, e.g. `mi`, `°c`, `bar`. */
  unit(...names: string[]): string | null {
    const index = this.index(...names);
    return index === -1 ? null : unitOf(this.columns[index] ?? "");
  }

  /** Columns this header carries that the caller never asked about. */
  unmapped(used: readonly number[]): string[] {
    const seen = new Set(used);
    return this.columns.filter((_, index) => !seen.has(index));
  }
}

function bareName(column: string): string {
  const paren = column.indexOf("(");
  const bare = paren === -1 ? column : column.slice(0, paren);
  return bare.trim().toLowerCase();
}

function unitOf(column: string): string | null {
  const open = column.lastIndexOf("(");
  const close = column.lastIndexOf(")");
  if (open === -1 || close < open) return null;
  return (
    column
      .slice(open + 1, close)
      .trim()
      .toLowerCase() || null
  );
}

/** `""` and unparseable values become null — exports leave cells blank. */
export function num(field: string | undefined): number | null {
  if (field === undefined) return null;
  const trimmed = field.trim();
  if (trimmed === "") return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

/** `1`/`0`, `true`/`false`, `yes`/`no`; anything else is null. */
export function bool(field: string | undefined): boolean | null {
  if (field === undefined) return null;
  switch (field.trim().toLowerCase()) {
    case "1":
    case "true":
    case "yes":
    case "on":
      return true;
    case "0":
    case "false":
    case "no":
    case "off":
      return false;
    default:
      return null;
  }
}

export function text(field: string | undefined): string | null {
  if (field === undefined) return null;
  const trimmed = field.trim();
  return trimmed === "" ? null : trimmed;
}

const TIMESTAMP_MIN_MS = Date.UTC(2010, 0, 1);

/**
 * Parses the timestamp formats exports use, all as UTC: `YYYY-MM-DD HH:MM:SS`,
 * the same with a `T` and optional fraction/offset, and epoch seconds or ms.
 */
export function parseTimestamp(field: string | undefined): number | null {
  if (field === undefined) return null;
  const value = field.trim();
  if (value === "") return null;

  if (value.length >= 19 && value.charCodeAt(4) === 45) {
    const year = +value.slice(0, 4);
    const month = +value.slice(5, 7);
    const day = +value.slice(8, 10);
    const hour = +value.slice(11, 13);
    const minute = +value.slice(14, 16);
    const second = +value.slice(17, 19);
    if (
      Number.isInteger(year) &&
      Number.isInteger(month) &&
      Number.isInteger(day) &&
      Number.isInteger(hour) &&
      Number.isInteger(minute) &&
      Number.isInteger(second)
    ) {
      // A trailing offset (or a "Z") means the string is not naive UTC.
      const tail = value.slice(19);
      if (tail === "" || tail === "Z" || /^\.\d+Z?$/.test(tail)) {
        const ms = /^\.(\d{1,3})/.exec(tail);
        return Date.UTC(year, month - 1, day, hour, minute, second, ms ? +ms[1]!.padEnd(3, "0") : 0);
      }
      const parsed = Date.parse(value.includes("T") ? value : value.replace(" ", "T"));
      return Number.isFinite(parsed) ? parsed : null;
    }
  }

  const epoch = Number(value);
  if (Number.isFinite(epoch) && epoch > 0) {
    // Distinguish seconds from milliseconds by magnitude.
    return epoch < TIMESTAMP_MIN_MS ? Math.round(epoch * 1000) : Math.round(epoch);
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

const MI_PER_KM = 0.62137119223733;

/** Tesla's API reports distances in miles; normalise whatever the export used. */
export function toMiles(value: number | null, unit: string | null): number | null {
  if (value === null) return null;
  return unit === "km" ? value * MI_PER_KM : value;
}

/** Tesla's API reports speed in mph. */
export function toMph(value: number | null, unit: string | null): number | null {
  if (value === null) return null;
  return unit === "km/h" || unit === "kmh" || unit === "kph" ? value * MI_PER_KM : value;
}

/** Tesla's API reports temperatures in Celsius. */
export function toCelsius(value: number | null, unit: string | null): number | null {
  if (value === null) return null;
  return unit === "°f" || unit === "f" ? ((value - 32) * 5) / 9 : value;
}

/** Tesla's API reports tyre pressure in bar. */
export function toBar(value: number | null, unit: string | null): number | null {
  if (value === null) return null;
  return unit === "psi" ? value / 14.503773773 : value;
}
