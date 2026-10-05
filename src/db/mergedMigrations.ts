/**
 * Before the first public release, the schema was built by eighteen migrations
 * (0001–0018); they were merged into the one `0001_init.sql` that ships now.
 *
 * A database that ran the whole old series already records `0001_init.sql`, so
 * it skips the merged file and carries on with whatever comes next — exactly
 * right. One that stopped part-way would skip it too, and silently lack the
 * columns the rest of the series added, so both migrators refuse to touch it.
 * Such a database can only come from a pre-release build, which is also what
 * can bring it level.
 *
 * By name alone, a database that ran only the old 0001 looks like one created
 * from the merged file, so that case is told apart by a table only the merged
 * schema (or the old 0017) creates.
 */
const LAST_PRE_MERGE = "0018_address_own_poi.sql";

/** The files between the first and the last, by exact name — new migrations reuse the numbers. */
const OLD_SERIES = new Set([
  "0002_lfp_from_vin.sql",
  "0003_period_stats_indexes.sql",
  "0004_open_row_indexes.sql",
  "0005_currency.sql",
  "0006_repair_and_speed_indexes.sql",
  "0007_car_next_due_at.sql",
  "0008_usable_when_new_kwh.sql",
  "0009_charge_battery_temp.sql",
  "0010_terrain_cache.sql",
  "0011_address_poi.sql",
  "0012_drive_origin_sweep.sql",
  "0013_update_check.sql",
  "0014_documents.sql",
  "0015_documents_per_car.sql",
  "0016_document_thumbnails.sql",
  "0017_telemetry.sql",
]);
export const MERGED_SCHEMA_MARKER_TABLE = "survey_responses";

/** Whether the stricter, schema-level check is needed at all. */
export function mayBeMidMerge(applied: ReadonlySet<string>): boolean {
  return applied.has("0001_init.sql") && !applied.has(LAST_PRE_MERGE);
}

export function assertNotMidMerge(applied: ReadonlySet<string>, hasMarkerTable: boolean): void {
  if (!mayBeMidMerge(applied)) return;
  const fromOldSeries = [...applied].some((name) => OLD_SERIES.has(name));
  if (!fromOldSeries && hasMarkerTable) return;
  throw new Error(
    `this database stopped part-way through EVBook's pre-release migrations ` +
      `(last applied: ${[...applied].sort().at(-1)}); bring it up to 0018_address_own_poi.sql ` +
      `with a pre-release build first`,
  );
}
