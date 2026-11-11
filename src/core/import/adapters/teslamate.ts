import { CopyColumns, copyRows, parseCopyHeader } from "../pgdump";
import type { DirectSource, ImportBundle, SourceDetection } from "../types";

/**
 * TeslaMate, read from the backup its documentation tells every user to make:
 *
 *   docker compose exec -T database pg_dump -U teslamate teslamate > teslamate.bck
 *
 * a plain-text PostgreSQL dump, optionally gzipped. Nothing has to be running
 * and no database has to be reachable — the file is the whole interface.
 *
 * TeslaMate's tables are what EVBook's schema was modelled on, and they already
 * hold finished drives and charging sessions, so this source is `direct`: its
 * rows are written as they are (`../teslamate.ts`), not re-derived from samples.
 * This file is only the part the browser needs — recognising a backup and
 * saying which cars it holds — and stays free of anything database-side.
 */

/** Tables whose presence in the DDL says "this is TeslaMate". */
const SIGNATURE_TABLES = ["cars", "drives", "positions", "charging_processes", "charges"];

/** The tables an import reads, in the order it writes them. */
export const TESLAMATE_TABLES = [
  "addresses",
  "geofences",
  "drives",
  "charging_processes",
  "states",
  "updates",
  "positions",
  "charges",
] as const;

export interface TeslaMateCar {
  /** TeslaMate's own id — what every other table refers to. */
  id: number;
  vin: string | null;
  name: string | null;
  model: string | null;
  trimBadging: string | null;
  marketingName: string | null;
  exteriorColor: string | null;
  wheelType: string | null;
  spoilerType: string | null;
}

/** The single file inside the bundle, which is all a backup is. */
async function dumpPath(bundle: ImportBundle): Promise<string | null> {
  const entries = await bundle.entries();
  return entries.length === 1 ? entries[0]!.path : null;
}

/**
 * Reads the cars out of a backup. The `cars` block sits near the top of the
 * data (pg_dump writes tables in name order, and only `addresses` and
 * `car_settings` come before it), so this stops long before the positions.
 */
export async function readTeslaMateCars(bundle: ImportBundle): Promise<TeslaMateCar[]> {
  const path = await dumpPath(bundle);
  if (!path) return [];
  const cars: TeslaMateCar[] = [];

  for await (const row of copyRows(stopAfterTable(bundle.lines(path), "cars"), { tables: new Set(["cars"]) })) {
    const columns = new CopyColumns(row.header);
    const f = row.fields;
    const id = columns.int(f, "id");
    if (id === null) continue;
    cars.push({
      id,
      vin: columns.text(f, "vin")?.trim().toUpperCase() || null,
      name: columns.text(f, "name"),
      model: columns.text(f, "model"),
      trimBadging: columns.text(f, "trim_badging"),
      marketingName: columns.text(f, "marketing_name"),
      exteriorColor: columns.text(f, "exterior_color"),
      wheelType: columns.text(f, "wheel_type"),
      spoilerType: columns.text(f, "spoiler_type"),
    });
  }
  return cars;
}

/** Passes lines through until the given table's COPY block has ended. */
async function* stopAfterTable(lines: AsyncIterable<string>, table: string): AsyncIterable<string> {
  let inside = false;
  for await (const line of lines) {
    yield line;
    if (inside && line === "\\.") return;
    if (!inside && line.startsWith("COPY ")) {
      const header = parseCopyHeader(line);
      if (header?.table === table) inside = true;
      // Past it in name order: the dump has no cars block, or an unusual order.
      else if (header && header.table > table && header.table !== "car_settings") return;
    }
  }
}

export const teslamateSource: DirectSource = {
  id: "teslamate",
  label: "TeslaMate",
  mode: "direct",
  describe: "TeslaMate database backup (teslamate.bck from pg_dump, plain or gzipped)",
  howToExport:
    "On the TeslaMate host: docker compose exec -T database pg_dump -U teslamate teslamate > teslamate.bck " +
    "(gzip it to upload faster).",
  accept: ".bck,.sql,.gz",

  async detect(bundle: ImportBundle): Promise<SourceDetection> {
    const none: SourceDetection = { confidence: 0, vin: null, recognised: [], missing: [], notes: [] };
    const path = await dumpPath(bundle);
    if (!path) return none;

    // The DDL comes first, so the table definitions are within the first few
    // hundred lines; the data blocks follow.
    const found = new Set<string>();
    let isDump = false;
    let lineCount = 0;
    for await (const line of bundle.lines(path)) {
      if (lineCount === 0 && line.startsWith("PGDMP")) {
        return {
          ...none,
          confidence: 0.6,
          recognised: [path],
          notes: [
            "this is a custom-format dump (pg_dump -Fc), which only PostgreSQL's own tools can read — " +
              "make a plain one: pg_restore -f teslamate.bck <this file>, or pg_dump without -Fc",
          ],
        };
      }
      lineCount++;
      if (line.startsWith("-- PostgreSQL database dump")) isDump = true;
      const table = /^CREATE TABLE (?:public\.)?"?(\w+)"? \(/.exec(line)?.[1];
      if (table) found.add(table);
      if (line.startsWith("COPY ") || lineCount > 20_000) break;
    }
    const recognisedTables = SIGNATURE_TABLES.filter((table) => found.has(table));
    if (!isDump || recognisedTables.length < 3) return none;

    const cars = await readTeslaMateCars(bundle);
    const vins = cars.map((car) => car.vin).filter((vin): vin is string => vin !== null);
    const notes: string[] = [];
    if (cars.length === 0) notes.push("the backup holds no cars");
    if (cars.length > 1) {
      notes.push(`${cars.length} cars (${vins.join(", ")}) — each is matched to an EVBook car by VIN`);
    }
    if (cars.length > vins.length) notes.push("a car in the backup has no VIN and cannot be imported");

    return {
      confidence: recognisedTables.length === SIGNATURE_TABLES.length ? 1 : 0.8,
      vin: vins.length === 1 ? vins[0]! : null,
      recognised: [path],
      missing: SIGNATURE_TABLES.filter((table) => !found.has(table)),
      notes,
    };
  },
};
