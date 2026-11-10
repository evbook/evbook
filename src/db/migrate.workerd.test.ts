import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { applyPending } from "./migrate";
import { MIGRATIONS } from "./migrations.generated";

/**
 * The worker's boot migrator, against the real D1. The suite's setup has
 * already applied every real migration through wrangler's own bookkeeping,
 * which is exactly the situation an updated worker wakes up in.
 */

const FAKE = [
  { name: "9998_migrate_test_a.sql", statements: ["CREATE TABLE migrate_test_a (id INTEGER PRIMARY KEY)"] },
  {
    name: "9999_migrate_test_b.sql",
    statements: [
      "CREATE TABLE migrate_test_b (id INTEGER PRIMARY KEY, label TEXT)",
      "INSERT INTO migrate_test_b (id, label) VALUES (1, 'seeded')",
    ],
  },
];

afterEach(async () => {
  await env.DB.prepare("DROP TABLE IF EXISTS migrate_test_a").run();
  await env.DB.prepare("DROP TABLE IF EXISTS migrate_test_b").run();
  await env.DB.prepare("DELETE FROM d1_migrations WHERE name LIKE '999%_migrate_test_%'").run();
});

describe("applyPending", () => {
  it("is a no-op on a database wrangler already migrated", async () => {
    expect(await applyPending(env.DB, MIGRATIONS)).toEqual([]);
  });

  it("applies what is missing, records it, and never applies it again", async () => {
    expect(await applyPending(env.DB, [...MIGRATIONS, ...FAKE])).toEqual(FAKE.map((m) => m.name));

    // All statements of a migration ran, not just the first.
    const seeded = await env.DB.prepare("SELECT label FROM migrate_test_b WHERE id = 1").first<{ label: string }>();
    expect(seeded?.label).toBe("seeded");

    // Bookkeeping in the same table wrangler uses, so a second pass is silent.
    expect(await applyPending(env.DB, [...MIGRATIONS, ...FAKE])).toEqual([]);
  });

  it("records nothing for a migration that fails part-way", async () => {
    const broken = [
      {
        name: "9999_migrate_test_b.sql",
        statements: ["CREATE TABLE migrate_test_b (id INTEGER PRIMARY KEY)", "INSERT INTO nowhere VALUES (1)"],
      },
    ];
    await expect(applyPending(env.DB, broken)).rejects.toThrow(/9999_migrate_test_b/);
    const row = await env.DB.prepare("SELECT 1 AS one FROM d1_migrations WHERE name = ?")
      .bind("9999_migrate_test_b.sql")
      .first();
    expect(row).toBeNull();
    // The batch was atomic: the table from the first statement is not there.
    const table = await env.DB.prepare("SELECT name FROM sqlite_master WHERE name = 'migrate_test_b'").first();
    expect(table).toBeNull();
  });
});
