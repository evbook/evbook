import { describe, expect, it } from "bun:test";
import { baseName, fileBundle, memoryBundle, zipBundle } from "./bundle";
import { buildZip, bytesReader } from "../../../test/zipfile";
import { gzip } from "../../../test/teslamate-dump";

async function collect(source: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const line of source) out.push(line);
  return out;
}

describe("base names", () => {
  it("takes the file name, lower-cased", () => {
    expect(baseName("export/Driving_States.CSV")).toBe("driving_states.csv");
    expect(baseName("a.csv")).toBe("a.csv");
  });
});

describe("memory bundle", () => {
  const bundle = memoryBundle("LRW3F7EB9MC123456.zip", { "a.csv": "x,y\n1,2\n" });

  it("lists entries with their base name", async () => {
    expect(await bundle.entries()).toEqual([{ path: "a.csv", name: "a.csv", size: 8 }]);
  });

  it("yields lines", async () => {
    expect(await collect(bundle.lines("a.csv"))).toEqual(["x,y", "1,2", ""]);
  });

  it("complains about a missing entry", () => {
    expect(() => bundle.lines("missing.csv")).toThrow(/not in/);
  });
});

describe("zip bundle", () => {
  it("reads entries and lines straight out of the archive", async () => {
    const bytes = await buildZip([
      { name: "export/driving_states.csv", content: "Timestamp (UTC),Latitude\n1,2\n", deflate: true },
    ]);
    const bundle = zipBundle("export.zip", bytesReader(bytes));

    expect(await bundle.entries()).toEqual([
      { path: "export/driving_states.csv", name: "driving_states.csv", size: 29 },
    ]);
    expect(await collect(bundle.lines("export/driving_states.csv"))).toEqual(["Timestamp (UTC),Latitude", "1,2"]);
  });

  it("can walk two entries at once", async () => {
    const bytes = await buildZip([
      { name: "one.csv", content: "1\n2\n3\n", deflate: true },
      { name: "two.csv", content: "a\nb\nc\n", deflate: true },
    ]);
    const bundle = zipBundle("export.zip", bytesReader(bytes));
    const [one, two] = await Promise.all([collect(bundle.lines("one.csv")), collect(bundle.lines("two.csv"))]);
    expect(one).toEqual(["1", "2", "3"]);
    expect(two).toEqual(["a", "b", "c"]);
  });
});

describe("file bundle", () => {
  const text = "-- PostgreSQL database dump\nCOPY public.a (id) FROM stdin;\n1\n\\.\n";

  it("reads a plain file as a one-entry bundle", async () => {
    const bundle = await fileBundle("teslamate.bck", bytesReader(new TextEncoder().encode(text)));
    expect(await bundle.entries()).toEqual([{ path: "teslamate.bck", name: "teslamate.bck", size: text.length }]);
    expect(await collect(bundle.lines("teslamate.bck"))).toEqual(text.trimEnd().split("\n"));
  });

  it("decompresses a gzipped file, named without the .gz", async () => {
    const bundle = await fileBundle("teslamate.bck.gz", bytesReader(await gzip(text)));
    expect((await bundle.entries()).map((entry) => entry.path)).toEqual(["teslamate.bck"]);
    expect(await collect(bundle.lines("teslamate.bck"))).toEqual(text.trimEnd().split("\n"));
  });

  it("tells a gzipped file by its bytes, not its name", async () => {
    const bundle = await fileBundle("backup.sql", bytesReader(await gzip(text)));
    expect(await collect(bundle.lines("backup.sql"))).toContain("-- PostgreSQL database dump");
  });

  it("hands a zip to the zip reader", async () => {
    const bytes = await buildZip([{ name: "a.csv", content: "1\n", deflate: true }]);
    const bundle = await fileBundle("export.zip", bytesReader(bytes));
    expect((await bundle.entries()).map((entry) => entry.path)).toEqual(["a.csv"]);
  });
});
