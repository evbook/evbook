import { describe, expect, it } from "bun:test";
import {
  CopyColumns,
  copyEvents,
  copyRows,
  decodeCopyField,
  parseCopyHeader,
  parseCopyLine,
  parsePgTimestamp,
} from "./pgdump";

async function* linesOf(text: string): AsyncIterable<string> {
  for (const line of text.split("\n")) yield line;
}

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of items) out.push(item);
  return out;
}

describe("COPY text format fields", () => {
  it("reads \\N as NULL, and only a bare \\N", () => {
    expect(decodeCopyField("\\N")).toBeNull();
    expect(decodeCopyField("\\\\N")).toBe("\\N");
    expect(decodeCopyField("")).toBe("");
  });

  it("decodes the backslash escapes", () => {
    expect(decodeCopyField("a\\tb\\nc\\rd\\\\e")).toBe("a\tb\nc\rd\\e");
    expect(decodeCopyField("\\b\\f\\v")).toBe("\b\f\v");
    // Any other escaped character stands for itself.
    expect(decodeCopyField("\\.\\q")).toBe(".q");
  });

  it("decodes octal and hex bytes as UTF-8", () => {
    expect(decodeCopyField("Caf\\303\\251")).toBe("Café");
    expect(decodeCopyField("\\x41\\x42")).toBe("AB");
    expect(decodeCopyField("\\101")).toBe("A");
  });

  it("leaves raw UTF-8 alone", () => {
    expect(decodeCopyField("Hauptstraße")).toBe("Hauptstraße");
  });

  it("splits a line on tabs, keeping empty fields", () => {
    expect(parseCopyLine("1\t\\N\t\tx\\ty")).toEqual(["1", null, "", "x\ty"]);
  });
});

describe("COPY headers", () => {
  it("reads the table and its columns", () => {
    expect(parseCopyHeader("COPY public.drives (id, start_date, car_id) FROM stdin;")).toEqual({
      schema: "public",
      table: "drives",
      columns: ["id", "start_date", "car_id"],
    });
  });

  it("unquotes quoted identifiers", () => {
    expect(parseCopyHeader('COPY "public"."my table" (id, "date", "a""b") FROM stdin;')).toEqual({
      schema: "public",
      table: "my table",
      columns: ["id", "date", 'a"b'],
    });
  });

  it("refuses anything else", () => {
    expect(parseCopyHeader("COPY drives FROM stdin;")).toBeNull();
    expect(parseCopyHeader("CREATE TABLE public.drives (")).toBeNull();
  });
});

describe("streaming blocks", () => {
  const dump = [
    "-- PostgreSQL database dump",
    "CREATE TABLE public.a (id integer);",
    "COPY public.a (id, name) FROM stdin;",
    "1\tone",
    "2\ttwo",
    "3\tthree",
    "\\.",
    "COPY public.b (name, id) FROM stdin;",
    "x\t9",
    "\\.",
    "SELECT pg_catalog.setval('public.a_id_seq', 3, true);",
  ].join("\n");

  it("yields every block's start and end, and rows of the wanted tables only", async () => {
    const events = await collect(copyEvents(linesOf(dump), { tables: new Set(["b"]) }));
    expect(events.map((event) => `${event.kind}:${event.header.table}`)).toEqual([
      "start:a",
      "end:a",
      "start:b",
      "row:b",
      "end:b",
    ]);
  });

  it("skips rows already handled, to resume a table part-way", async () => {
    const rows = await collect(copyRows(linesOf(dump), { tables: new Set(["a"]), skip: { table: "a", rows: 2 } }));
    expect(rows.map((row) => row.fields)).toEqual([["3", "three"]]);
  });

  it("looks columns up by name, whatever their position", async () => {
    const [row] = await collect(copyRows(linesOf(dump), { tables: new Set(["b"]) }));
    const columns = new CopyColumns(row!.header);
    expect(columns.int(row!.fields, "id")).toBe(9);
    expect(columns.text(row!.fields, "name")).toBe("x");
    expect(columns.text(row!.fields, "missing")).toBeNull();
    expect(columns.has("missing")).toBe(false);
  });

  it("types booleans and numbers", () => {
    const columns = new CopyColumns({ schema: null, table: "t", columns: ["b", "n", "e"] });
    expect(columns.bool(["t", "1.5", ""], "b")).toBe(true);
    expect(columns.bool(["f", "1.5", ""], "b")).toBe(false);
    expect(columns.num(["t", "1.5", ""], "n")).toBe(1.5);
    expect(columns.int(["t", "1.5", ""], "n")).toBe(2);
    expect(columns.num(["t", "1.5", ""], "e")).toBeNull();
    expect(columns.num([null, null, null], "n")).toBeNull();
  });
});

describe("timestamps", () => {
  it("reads a timestamp without a zone as UTC", () => {
    expect(parsePgTimestamp("2023-01-01 08:00:00")).toBe(Date.UTC(2023, 0, 1, 8));
  });

  it("keeps milliseconds of a microsecond timestamp", () => {
    expect(parsePgTimestamp("2023-01-01 08:00:00.123456")).toBe(Date.UTC(2023, 0, 1, 8, 0, 0, 123));
    expect(parsePgTimestamp("2023-01-01 08:00:00.5")).toBe(Date.UTC(2023, 0, 1, 8, 0, 0, 500));
  });

  it("applies an offset", () => {
    expect(parsePgTimestamp("2023-01-01 10:00:00+02")).toBe(Date.UTC(2023, 0, 1, 8));
    expect(parsePgTimestamp("2023-01-01 03:30:00-04:30")).toBe(Date.UTC(2023, 0, 1, 8));
  });

  it("returns null for anything else", () => {
    expect(parsePgTimestamp(null)).toBeNull();
    expect(parsePgTimestamp("yesterday")).toBeNull();
  });
});
