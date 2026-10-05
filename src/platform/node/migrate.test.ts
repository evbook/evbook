import { copyFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { runMigrations } from "./migrate";

describe("runMigrations", () => {
  it("applies the real migrations in order, once, into d1_migrations", () => {
    const sqlite = new DatabaseSync(":memory:");

    const first = runMigrations(sqlite, "./migrations");
    expect(first[0]).toBe("0001_init.sql");
    expect(first).toEqual([...first].sort());

    // The schema is actually there.
    const tables = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('cars', 'positions', 'drives')")
      .all();
    expect(tables.length).toBe(3);

    // Bookkeeping matches wrangler's, so a moved database is never re-applied.
    const rows = sqlite.prepare("SELECT name FROM d1_migrations ORDER BY id").all() as { name: string }[];
    expect(rows.map((row) => row.name)).toEqual(first);
    expect(runMigrations(sqlite, "./migrations")).toEqual([]);
  });

  describe("databases from before the pre-release migrations 0001–0018 were merged", () => {
    const OLD_SERIES_TAIL = [
      "0002_lfp_from_vin.sql",
      "0005_currency.sql",
      "0017_telemetry.sql",
      "0018_address_own_poi.sql",
    ];
    const record = (sqlite: DatabaseSync, names: string[]) => {
      const insert = sqlite.prepare("INSERT INTO d1_migrations (name) VALUES (?)");
      for (const name of names) insert.run(name);
    };

    it("leaves a database that ran the whole old series alone, and applies what follows", () => {
      // The schema itself came from the old series; the merged file is identical.
      const sqlite = new DatabaseSync(":memory:");
      runMigrations(sqlite, "./migrations");
      record(sqlite, OLD_SERIES_TAIL);

      const directory = mkdtempSync(join(tmpdir(), "evbook-merged-"));
      copyFileSync("./migrations/0001_init.sql", join(directory, "0001_init.sql"));
      // A later migration reuses a number the old series had; only names count.
      writeFileSync(join(directory, "0002_next.sql"), "CREATE TABLE next_thing (id INTEGER PRIMARY KEY);");
      expect(runMigrations(sqlite, directory)).toEqual(["0002_next.sql"]);
      expect(runMigrations(sqlite, directory)).toEqual([]);
    });

    it("lets a database created from the merged file carry on with new migrations", () => {
      const directory = mkdtempSync(join(tmpdir(), "evbook-merged-"));
      copyFileSync("./migrations/0001_init.sql", join(directory, "0001_init.sql"));
      const sqlite = new DatabaseSync(":memory:");
      expect(runMigrations(sqlite, directory)).toEqual(["0001_init.sql"]);

      writeFileSync(join(directory, "0002_next.sql"), "CREATE TABLE next_thing (id INTEGER PRIMARY KEY);");
      expect(runMigrations(sqlite, directory)).toEqual(["0002_next.sql"]);
      expect(runMigrations(sqlite, directory)).toEqual([]);
    });

    it("refuses a database that stopped part-way through the old series", () => {
      const sqlite = new DatabaseSync(":memory:");
      runMigrations(sqlite, "./migrations");
      record(sqlite, ["0002_lfp_from_vin.sql", "0005_currency.sql"]);
      expect(() => runMigrations(sqlite, "./migrations")).toThrow(/pre-release migrations/);
    });

    it("refuses a database that only ever ran the original 0001", () => {
      // Same name as the merged file, but none of what came after it.
      const sqlite = new DatabaseSync(":memory:");
      sqlite.exec(
        `CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE,
           applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);
         CREATE TABLE cars (id INTEGER PRIMARY KEY);`,
      );
      record(sqlite, ["0001_init.sql"]);
      expect(() => runMigrations(sqlite, "./migrations")).toThrow(/pre-release migrations/);
    });
  });

  it("rolls a failing migration back and leaves it unrecorded", () => {
    const directory = mkdtempSync(join(tmpdir(), "evbook-migrate-"));
    writeFileSync(join(directory, "0001_ok.sql"), "CREATE TABLE ok (id INTEGER PRIMARY KEY);");
    writeFileSync(join(directory, "0002_bad.sql"), "CREATE TABLE bad (id INTEGER PRIMARY KEY);\nSYNTAX ERROR;");

    const sqlite = new DatabaseSync(":memory:");
    expect(() => runMigrations(sqlite, directory)).toThrow(/0002_bad\.sql/);
    // 0001 applied and recorded; 0002 fully rolled back, half-table included.
    expect(sqlite.prepare("SELECT name FROM d1_migrations").all()).toEqual([{ name: "0001_ok.sql" }]);
    expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE name = 'bad'").all()).toEqual([]);
  });
});
