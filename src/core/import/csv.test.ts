import { describe, expect, it } from "vitest";
import {
  CsvHeader,
  bool,
  linesFromChunks,
  num,
  parseCsv,
  parseTimestamp,
  text,
  toBar,
  toCelsius,
  toMiles,
  toMph,
} from "./csv";

async function* chunks(...parts: string[]): AsyncIterable<Uint8Array> {
  const encoder = new TextEncoder();
  for (const part of parts) yield encoder.encode(part);
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of source) out.push(item);
  return out;
}

function lines(...values: string[]): AsyncIterable<string> {
  return (async function* () {
    yield* values;
  })();
}

describe("line decoding", () => {
  it("splits on newlines across chunk boundaries", async () => {
    expect(await collect(linesFromChunks(chunks("a,b\nc,", "d\ne,f")))).toEqual(["a,b", "c,d", "e,f"]);
  });

  it("strips carriage returns and keeps a trailing line", async () => {
    expect(await collect(linesFromChunks(chunks("a\r\nb\r\n")))).toEqual(["a", "b"]);
    expect(await collect(linesFromChunks(chunks("a\nb")))).toEqual(["a", "b"]);
  });

  it("decodes multi-byte characters split across chunks", async () => {
    const encoded = new TextEncoder().encode("Zürich");
    const source = (async function* () {
      yield encoded.subarray(0, 2); // splits the ü
      yield encoded.subarray(2);
    })();
    expect(await collect(linesFromChunks(source))).toEqual(["Zürich"]);
  });
});

describe("csv records", () => {
  it("reads the fully quoted shape exports use", async () => {
    const rows = await collect(parseCsv(lines('"2024-04-11 09:09:22","5790.552",,"-0.7"')));
    expect(rows).toEqual([["2024-04-11 09:09:22", "5790.552", "", "-0.7"]]);
  });

  it("reads unquoted and mixed fields", async () => {
    expect(await collect(parseCsv(lines("Timestamp (UTC),Latitude", '"x",1')))).toEqual([
      ["Timestamp (UTC)", "Latitude"],
      ["x", "1"],
    ]);
  });

  it("keeps commas and doubled quotes inside a quoted field", async () => {
    const rows = await collect(parseCsv(lines('"a,b","say ""hi""",c')));
    expect(rows).toEqual([["a,b", 'say "hi"', "c"]]);
  });

  it("joins a record that spans lines inside quotes", async () => {
    const rows = await collect(parseCsv(lines('"one', 'two",3')));
    expect(rows).toEqual([["one\ntwo", "3"]]);
  });

  it("skips blank lines", async () => {
    expect(await collect(parseCsv(lines("a", "", "b")))).toEqual([["a"], ["b"]]);
  });
});

describe("header lookup", () => {
  const header = new CsvHeader(["Timestamp (UTC)", "Odometer (mi)", "Speed (mph)", "Inside Temp (°C)"]);

  it("matches on the name before the unit, case-insensitively", () => {
    expect(header.index("odometer")).toBe(1);
    expect(header.index("ODOMETER")).toBe(1);
    expect(header.index("nope", "speed")).toBe(2);
    expect(header.index("nope")).toBe(-1);
  });

  it("reports the unit the export was written in", () => {
    expect(header.unit("odometer")).toBe("mi");
    expect(header.unit("inside temp")).toBe("°c");
    expect(header.unit("missing")).toBeNull();
  });

  it("lists columns nobody claimed", () => {
    expect(header.unmapped([0, 1])).toEqual(["Speed (mph)", "Inside Temp (°C)"]);
  });
});

describe("field coercion", () => {
  it("treats blank cells as missing", () => {
    expect(num("")).toBeNull();
    expect(num("  ")).toBeNull();
    expect(num("12.5")).toBe(12.5);
    expect(num("-0.7")).toBe(-0.7);
    expect(num("abc")).toBeNull();
    expect(num(undefined)).toBeNull();
  });

  it("reads the booleans exports write", () => {
    expect(bool("1")).toBe(true);
    expect(bool("0")).toBe(false);
    expect(bool("true")).toBe(true);
    expect(bool("")).toBeNull();
    expect(text("")).toBeNull();
    expect(text(" P ")).toBe("P");
  });
});

describe("timestamps", () => {
  it("reads a naive UTC timestamp", () => {
    expect(parseTimestamp("2024-04-11 09:09:22")).toBe(Date.UTC(2024, 3, 11, 9, 9, 22));
  });

  it("reads ISO variants", () => {
    expect(parseTimestamp("2024-04-11T09:09:22Z")).toBe(Date.UTC(2024, 3, 11, 9, 9, 22));
    expect(parseTimestamp("2024-04-11T09:09:22.500Z")).toBe(Date.UTC(2024, 3, 11, 9, 9, 22, 500));
    expect(parseTimestamp("2024-04-11T11:09:22+02:00")).toBe(Date.UTC(2024, 3, 11, 9, 9, 22));
  });

  it("reads epoch seconds and milliseconds", () => {
    expect(parseTimestamp("1712826562")).toBe(1_712_826_562_000);
    expect(parseTimestamp("1712826562000")).toBe(1_712_826_562_000);
  });

  it("rejects nonsense", () => {
    expect(parseTimestamp("")).toBeNull();
    expect(parseTimestamp("not a date")).toBeNull();
  });
});

describe("unit normalisation", () => {
  it("converts to the units Tesla's API reports", () => {
    expect(toMiles(100, "km")).toBeCloseTo(62.137, 3);
    expect(toMiles(100, "mi")).toBe(100);
    expect(toMph(100, "km/h")).toBeCloseTo(62.137, 3);
    expect(toCelsius(50, "°f")).toBeCloseTo(10, 6);
    expect(toCelsius(10, "°c")).toBe(10);
    expect(toBar(29.0075, "psi")).toBeCloseTo(2, 3);
    expect(toBar(2.5, "bar")).toBe(2.5);
  });

  it("leaves missing values missing", () => {
    expect(toMiles(null, "km")).toBeNull();
    expect(toCelsius(null, "°f")).toBeNull();
  });
});
