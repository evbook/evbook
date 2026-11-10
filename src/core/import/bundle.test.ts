import { describe, expect, it } from "bun:test";
import { baseName, memoryBundle, zipBundle } from "./bundle";
import { buildZip, bytesReader } from "../../../test/zipfile";

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
