import { decodeVin } from "../../../shared/vin";
import type { SqlDatabase } from "../../platform/ports";

export interface ResolvedCar {
  carId: number;
  /** How the car was chosen, so the caller can say so in the report. */
  how: "id" | "vin" | "created" | "only-car";
}

/**
 * Finds the car this history belongs to.
 *
 * A VIN is the reliable answer, and vendor exports usually carry one in the file
 * name. When they do not — the user renamed the download, say — a database with
 * exactly one car has only one sensible answer, so use it and let the caller
 * report that it did. With several cars and no VIN there is nothing to guess
 * from, so ask.
 */
export async function resolveCar(
  db: SqlDatabase,
  target: { carId?: number; vin: string | null; name?: string },
): Promise<ResolvedCar> {
  if (target.carId !== undefined) {
    const row = await db.prepare("SELECT id FROM cars WHERE id = ?").bind(target.carId).first<{ id: number }>();
    if (!row) throw new Error(`car ${target.carId} does not exist`);
    return { carId: row.id, how: "id" };
  }

  if (!target.vin) {
    const cars = await db.prepare("SELECT id, vin FROM cars ORDER BY id").all<{ id: number; vin: string }>();
    if (cars.results.length === 1) return { carId: cars.results[0]!.id, how: "only-car" };
    if (cars.results.length === 0) {
      throw new Error(
        "the export carries no VIN, and there is no car to import into — say which car this history belongs to",
      );
    }
    throw new Error(
      `the export carries no VIN — say which car this history belongs to (${cars.results
        .map((car) => car.vin)
        .join(", ")})`,
    );
  }

  const existing = await db.prepare("SELECT id FROM cars WHERE vin = ?").bind(target.vin).first<{ id: number }>();
  if (existing) return { carId: existing.id, how: "vin" };

  const info = decodeVin(target.vin);
  const now = Date.now();
  const inserted = await db
    .prepare("INSERT INTO cars (vin, name, model, inserted_at, updated_at) VALUES (?, ?, ?, ?, ?) RETURNING id")
    .bind(target.vin, target.name ?? target.vin, info.model, now, now)
    .first<{ id: number }>();
  if (!inserted) throw new Error("failed to create the car row");

  // An imported car has no Tesla id, so leave polling off: the watchdog would
  // otherwise wake a Durable Object every ten minutes for a car it cannot fetch.
  // The pack chemistry comes from the VIN, so nobody has to be asked for it.
  await db
    .prepare("INSERT OR IGNORE INTO car_settings (car_id, enabled, lfp_battery) VALUES (?, 0, ?)")
    .bind(inserted.id, info.batteryChemistry === "lfp" ? 1 : 0)
    .run();
  return { carId: inserted.id, how: "created" };
}
