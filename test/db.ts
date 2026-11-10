import { env, runInDurableObject } from "cloudflare:test";

/**
 * Database and Durable Object housekeeping shared by the worker specs.
 *
 * Isolated storage is off — it cannot stack SQLite-backed Durable Objects — so
 * every suite clears what it touches up front instead of relying on the pool.
 */

/** Deletes every row from the given tables, children before parents. */
export async function clearTables(...tables: string[]): Promise<void> {
  for (const table of tables) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
}

/** Drops a car's Durable Object storage and its pending alarm. */
async function clearVehicleDO(carId: number): Promise<void> {
  await runInDurableObject(env.VEHICLE_DO.getByName(`car:${carId}`), async (_instance, state) => {
    await state.storage.deleteAll();
    await state.storage.deleteAlarm();
  });
}

/**
 * Resets the world to a single freshly registered car with default settings —
 * what the router specs for auth, settings and cars all start from.
 *
 * Give every spec file its own car id: a Durable Object instance created by one
 * file is invalidated for the next one, so two files must never share a car.
 */
export async function resetCar(carId: number): Promise<void> {
  await clearVehicleDO(carId);
  await clearTables("charging_processes", "positions", "drives", "states", "cars");
  await env.DB.prepare(
    "UPDATE settings SET unit_of_length='km', unit_of_temperature='C', preferred_range='rated', timezone='UTC', timezone_chosen=0, document_storage='database' WHERE id=1",
  ).run();
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO cars (id, eid, vid, vin, name, inserted_at, updated_at) VALUES (?, 10, 20, 'VIN1', 'Bro', ?, ?)",
  )
    .bind(carId, now, now)
    .run();
  await env.DB.prepare("INSERT OR REPLACE INTO car_settings (car_id) VALUES (?)").bind(carId).run();
}
