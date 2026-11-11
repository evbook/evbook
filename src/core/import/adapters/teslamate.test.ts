import { describe, expect, it } from "bun:test";
import { memoryBundle } from "../bundle";
import { detectSources } from "../sources";
import { readTeslaMateCars, teslamateSource } from "./teslamate";
import { NEW_DUMP, NEW_VIN_1, NEW_VIN_2, OLD_DUMP, OLD_VIN } from "../../../../test/teslamate-dump";

const backup = (text: string, name = "teslamate.bck") => memoryBundle(name, { [name]: text });

describe("recognising a TeslaMate backup", () => {
  it("is certain about a plain pg_dump of TeslaMate's database", async () => {
    const detection = await teslamateSource.detect(backup(OLD_DUMP));
    expect(detection.confidence).toBe(1);
    expect(detection.vin).toBe(OLD_VIN);
    expect(detection.recognised).toEqual(["teslamate.bck"]);
  });

  it("names every car of a backup that holds several, and claims no single VIN", async () => {
    const detection = await teslamateSource.detect(backup(NEW_DUMP));
    expect(detection.vin).toBeNull();
    expect(detection.notes.join(" ")).toContain(`2 cars (${NEW_VIN_1}, ${NEW_VIN_2})`);
  });

  it("is what auto-detection picks, over Tessie", async () => {
    const [best] = await detectSources(backup(NEW_DUMP));
    expect(best?.source.id).toBe("teslamate");
  });

  it("says how to convert a custom-format dump rather than failing silently", async () => {
    const detection = await teslamateSource.detect(backup("PGDMP\u0001\u000e\u0000binary"));
    expect(detection.confidence).toBeGreaterThan(0.5);
    expect(detection.notes[0]).toContain("pg_restore");
  });

  it("leaves other files alone", async () => {
    expect((await teslamateSource.detect(backup("Timestamp (UTC),Latitude\n1,2", "x.csv"))).confidence).toBe(0);
    const otherDb = "-- PostgreSQL database dump\nCREATE TABLE public.users (\n    id integer\n);\n";
    expect((await teslamateSource.detect(backup(otherDb))).confidence).toBe(0);
    expect((await teslamateSource.detect(memoryBundle("x.zip", { "a.csv": "", "b.csv": "" }))).confidence).toBe(0);
  });
});

describe("reading the cars", () => {
  it("reads them by column name, whatever the layout", async () => {
    const [newer] = await readTeslaMateCars(backup(NEW_DUMP));
    expect(newer).toEqual({
      id: 1,
      vin: NEW_VIN_1,
      name: "Bolt",
      model: "3",
      trimBadging: "74D",
      marketingName: "Long Range AWD",
      exteriorColor: "MidnightSilver",
      wheelType: "Pinwheel18",
      spoilerType: null,
    });
    const [older] = await readTeslaMateCars(backup(OLD_DUMP));
    expect(older).toMatchObject({ id: 4, vin: OLD_VIN, name: "Old \\ Faithful", marketingName: null });
  });

  it("stops reading once the cars are behind it", async () => {
    let lines = 0;
    const counting = memoryBundle("teslamate.bck", { "teslamate.bck": NEW_DUMP });
    const original = counting.lines.bind(counting);
    counting.lines = (path: string) =>
      (async function* () {
        for await (const line of original(path)) {
          lines++;
          yield line;
        }
      })();
    await readTeslaMateCars(counting);
    const charges = NEW_DUMP.split("\n").findIndex((line) => line.startsWith("COPY public.charges "));
    expect(lines).toBeLessThan(charges);
  });
});
