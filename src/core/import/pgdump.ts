/**
 * Streaming reader for the table data in a PostgreSQL plain-text dump
 * (`pg_dump` without `-F`), which is what TeslaMate's backup instructions
 * produce.
 *
 * A plain dump is DDL followed by one `COPY` block per table:
 *
 *   COPY public.drives (id, start_date, end_date, …) FROM stdin;
 *   1\t2021-03-04 08:00:00\t\N\t…
 *   \.
 *
 * Rows are tab-separated in COPY's text format: `\N` is NULL, and backslash
 * escapes stand for tabs, newlines, backslashes and arbitrary bytes. Columns are
 * read from each block's own header, never assumed by position, so dumps from
 * different schema versions read the same way.
 *
 * Portable on purpose — no Node APIs — so the browser can run it for detection.
 */

export interface CopyHeader {
  schema: string | null;
  table: string;
  columns: string[];
}

/** One data row, with the block's header for column lookup. */
export interface CopyRow {
  header: CopyHeader;
  /** Decoded fields, `null` for `\N`. */
  fields: (string | null)[];
}

const COPY_PREFIX = "COPY ";
const END_OF_DATA = "\\.";

/**
 * Parses `COPY [schema.]table (col, …) FROM stdin;`. Returns null for anything
 * else — including a `COPY` with no column list, which pg_dump never writes.
 */
export function parseCopyHeader(line: string): CopyHeader | null {
  if (!line.startsWith(COPY_PREFIX) || !line.endsWith("FROM stdin;")) return null;
  const open = line.indexOf("(");
  const close = line.lastIndexOf(")");
  if (open === -1 || close < open) return null;

  const name = splitIdentifiers(line.slice(COPY_PREFIX.length, open).trim(), ".");
  if (name.length === 0 || name.length > 2) return null;
  const columns = splitIdentifiers(line.slice(open + 1, close), ",");
  return {
    schema: name.length === 2 ? name[0]! : null,
    table: name[name.length - 1]!,
    columns,
  };
}

/** Splits on `separator` outside double quotes, unquoting `"a""b"` identifiers. */
function splitIdentifiers(text: string, separator: string): string[] {
  const out: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          current += '"';
          i++;
        } else quoted = false;
      } else current += char;
    } else if (char === '"') quoted = true;
    else if (char === separator) {
      out.push(current.trim());
      current = "";
    } else current += char;
  }
  if (current.trim().length > 0 || out.length > 0) out.push(current.trim());
  return out;
}

/** Splits one COPY text-format line into decoded fields. */
export function parseCopyLine(line: string): (string | null)[] {
  const fields: (string | null)[] = [];
  let start = 0;
  for (;;) {
    const tab = line.indexOf("\t", start);
    const raw = tab === -1 ? line.slice(start) : line.slice(start, tab);
    fields.push(decodeCopyField(raw));
    if (tab === -1) return fields;
    start = tab + 1;
  }
}

const SIMPLE_ESCAPES: Record<string, string> = {
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
  "\\": "\\",
};

/**
 * One field of COPY text format. `\N` alone is NULL; otherwise backslash
 * sequences decode as PostgreSQL documents them — `\b \f \n \r \t \v \\`,
 * `\ooo` octal and `\xHH` hex bytes (UTF-8 encoded, so a byte sequence decodes
 * as text), and any other escaped character stands for itself.
 */
export function decodeCopyField(raw: string): string | null {
  if (raw === "\\N") return null;
  if (!raw.includes("\\")) return raw;

  let out = "";
  let bytes: number[] = [];
  const flushBytes = () => {
    if (bytes.length === 0) return;
    out += new TextDecoder().decode(new Uint8Array(bytes));
    bytes = [];
  };

  for (let i = 0; i < raw.length; i++) {
    const char = raw[i]!;
    if (char !== "\\" || i === raw.length - 1) {
      flushBytes();
      out += char;
      continue;
    }
    const next = raw[i + 1]!;
    if (next >= "0" && next <= "7") {
      let digits = next;
      while (digits.length < 3 && raw[i + 1 + digits.length]! >= "0" && raw[i + 1 + digits.length]! <= "7") {
        digits += raw[i + 1 + digits.length];
      }
      bytes.push(parseInt(digits, 8) & 0xff);
      i += digits.length;
      continue;
    }
    if (next === "x" && /[0-9a-fA-F]/.test(raw[i + 2] ?? "")) {
      const digits = /[0-9a-fA-F]/.test(raw[i + 3] ?? "") ? raw.slice(i + 2, i + 4) : raw[i + 2]!;
      bytes.push(parseInt(digits, 16));
      i += 1 + digits.length;
      continue;
    }
    flushBytes();
    out += SIMPLE_ESCAPES[next] ?? next;
    i++;
  }
  flushBytes();
  return out;
}

export interface CopyReadOptions {
  /** Only these tables' rows are decoded; others are skipped without parsing. */
  tables?: ReadonlySet<string>;
  /** Called with every block's header as it starts, wanted or not. */
  onHeader?(header: CopyHeader): void;
  /**
   * Rows of a table to pass over before decoding resumes — how a sliced import
   * gets back to where the previous slice stopped. Skipped rows are counted,
   * never parsed.
   */
  skip?: { table: string; rows: number };
}

/** What a dump holds, block by block: where each starts, its rows, where it ends. */
export type CopyEvent =
  | { kind: "start"; header: CopyHeader }
  | { kind: "row"; header: CopyHeader; fields: (string | null)[] }
  | { kind: "end"; header: CopyHeader };

/**
 * Every COPY block in dump order: a `start` and an `end` for each, and a `row`
 * for each data line of the wanted tables. Lines outside COPY blocks — the DDL,
 * `SELECT setval(…)`, comments — are passed over.
 */
export async function* copyEvents(
  lines: AsyncIterable<string>,
  options: CopyReadOptions = {},
): AsyncIterable<CopyEvent> {
  let header: CopyHeader | null = null;
  let wanted = false;
  let toSkip = 0;

  for await (const line of lines) {
    if (header === null) {
      if (!line.startsWith(COPY_PREFIX)) continue;
      header = parseCopyHeader(line);
      if (header === null) continue;
      options.onHeader?.(header);
      wanted = !options.tables || options.tables.has(header.table);
      toSkip = options.skip?.table === header.table ? options.skip.rows : 0;
      yield { kind: "start", header };
      continue;
    }
    if (line === END_OF_DATA) {
      const ended: CopyHeader = header;
      header = null;
      yield { kind: "end", header: ended };
      continue;
    }
    if (!wanted) continue;
    if (toSkip > 0) {
      toSkip--;
      continue;
    }
    yield { kind: "row", header, fields: parseCopyLine(line) };
  }
}

/** Just the data rows of the wanted tables, in dump order. */
export async function* copyRows(lines: AsyncIterable<string>, options: CopyReadOptions = {}): AsyncIterable<CopyRow> {
  for await (const event of copyEvents(lines, options)) {
    if (event.kind === "row") yield { header: event.header, fields: event.fields };
  }
}

/** Column lookup for one block, by name. Unknown columns read as null. */
export class CopyColumns {
  private readonly index = new Map<string, number>();

  constructor(readonly header: CopyHeader) {
    header.columns.forEach((name, i) => this.index.set(name, i));
  }

  has(column: string): boolean {
    return this.index.has(column);
  }

  text(fields: (string | null)[], column: string): string | null {
    const i = this.index.get(column);
    return i === undefined ? null : (fields[i] ?? null);
  }

  num(fields: (string | null)[], column: string): number | null {
    const value = this.text(fields, column);
    if (value === null || value === "") return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  int(fields: (string | null)[], column: string): number | null {
    const value = this.num(fields, column);
    return value === null ? null : Math.round(value);
  }

  bool(fields: (string | null)[], column: string): boolean | null {
    const value = this.text(fields, column);
    if (value === "t" || value === "true") return true;
    if (value === "f" || value === "false") return false;
    return null;
  }

  /** A `timestamp` column as epoch ms. */
  date(fields: (string | null)[], column: string): number | null {
    return parsePgTimestamp(this.text(fields, column));
  }
}

/**
 * PostgreSQL's text output for `timestamp` and `timestamptz`:
 * `2021-03-04 08:00:00`, with optional fractional seconds and, for timestamptz,
 * an offset (`+00`, `+02:00`). A timestamp without a zone is UTC — that is how
 * TeslaMate stores every date.
 */
export function parsePgTimestamp(value: string | null): number | null {
  if (value === null) return null;
  const match =
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(?:([+-])(\d{2})(?::?(\d{2}))?)?$/.exec(
      value.trim(),
    );
  if (!match) return null;
  const [, y, mo, d, h, mi, s, fraction, sign, offH, offM] = match;
  const ms = fraction ? Math.floor(Number(fraction.padEnd(6, "0")) / 1000) : 0;
  let at = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), ms);
  if (sign) {
    const offset = (Number(offH) * 60 + Number(offM ?? 0)) * 60_000;
    at += sign === "+" ? -offset : offset;
  }
  return Number.isFinite(at) ? at : null;
}
