import { Hono } from "hono";
import type { AppEnv } from "../platform/env";
import { z } from "zod";
import type { CarSettingsDto, GlobalSettingsDto } from "@shared/api-types";
import { CURRENCY_CODES, DEFAULT_CURRENCY, isCurrencyCode } from "@shared/currency";
import { TELEMETRY_LEVELS, isTelemetryLevel } from "@shared/telemetry";
import { recordVersionMilestones } from "../core/telemetry";
import { Repo } from "../db/repo";
import type { SqlDatabase } from "../platform/ports";

const GlobalPatch = z.object({
  unitOfLength: z.enum(["km", "mi"]).optional(),
  unitOfTemperature: z.enum(["C", "F"]).optional(),
  unitOfPressure: z.enum(["bar", "psi"]).optional(),
  currency: z.enum(CURRENCY_CODES).optional(),
  preferredRange: z.enum(["ideal", "rated"]).optional(),
  timezone: z.string().min(1).max(64).optional(),
  geocodeLanguage: z.string().min(2).max(8).optional(),
  telemetryLevel: z.enum(TELEMETRY_LEVELS).optional(),
  documentStorage: z.enum(["database", "bucket"]).optional(),
});

const CarPatch = z.object({
  enabled: z.boolean().optional(),
  // Bounds mirror TeslaMate's selects; suspend_min below ~12 keeps cars awake.
  suspendMin: z.number().int().min(12).max(90).optional(),
  suspendAfterIdleMin: z.number().int().min(3).max(60).optional(),
  reqNotUnlocked: z.boolean().optional(),
  freeSupercharging: z.boolean().optional(),
  lfpBattery: z.boolean().optional(),
  // Null clears the pick and hands the figure back to the VIN.
  usableWhenNewKwh: z.number().min(10).max(250).nullable().optional(),
});

interface GlobalRow {
  unit_of_length: "km" | "mi";
  unit_of_temperature: "C" | "F";
  unit_of_pressure: "bar" | "psi";
  currency: string;
  preferred_range: "ideal" | "rated";
  timezone: string;
  geocode_language: string;
  telemetry_level: string;
  document_storage: string;
}

/** Everything but `documentBucket`, which is the deployment's, not the database's. */
export type StoredGlobalSettings = Omit<GlobalSettingsDto, "documentBucket">;

export async function readGlobalSettings(db: SqlDatabase): Promise<StoredGlobalSettings> {
  const row = await db
    .prepare(
      "SELECT unit_of_length, unit_of_temperature, unit_of_pressure, currency, preferred_range, timezone, " +
        "geocode_language, telemetry_level, document_storage FROM settings WHERE id = 1",
    )
    .first<GlobalRow>();
  return {
    unitOfLength: row?.unit_of_length ?? "km",
    unitOfTemperature: row?.unit_of_temperature ?? "C",
    unitOfPressure: row?.unit_of_pressure ?? "bar",
    // The column has no CHECK behind it (see migrations/0001_init.sql), so a code the app
    // does not know falls back rather than reaching the formatter and throwing.
    currency: row && isCurrencyCode(row.currency) ? row.currency : DEFAULT_CURRENCY,
    preferredRange: row?.preferred_range ?? "rated",
    timezone: row?.timezone ?? "UTC",
    geocodeLanguage: row?.geocode_language ?? "en",
    // Same fallback logic as the currency, and here the direction matters:
    // a value the app does not know must read as "off", never as "send".
    telemetryLevel: row && isTelemetryLevel(row.telemetry_level) ? row.telemetry_level : "off",
    documentStorage: row?.document_storage === "bucket" ? "bucket" : "database",
  };
}

/** The settings as the client sees them: the stored ones, plus what this deployment has. */
async function settingsResponse(env: AppEnv): Promise<GlobalSettingsDto> {
  return { ...(await readGlobalSettings(env.DB)), documentBucket: env.bucket?.kind ?? null };
}

async function readCarSettings(db: SqlDatabase, carId: number): Promise<CarSettingsDto | null> {
  const row = await db
    .prepare(
      "SELECT car_id, enabled, suspend_min, suspend_after_idle_min, req_not_unlocked, free_supercharging, " +
        "lfp_battery, usable_when_new_kwh FROM car_settings WHERE car_id = ?",
    )
    .bind(carId)
    .first<{
      car_id: number;
      enabled: number;
      suspend_min: number;
      suspend_after_idle_min: number;
      req_not_unlocked: number;
      free_supercharging: number;
      lfp_battery: number;
      usable_when_new_kwh: number | null;
    }>();
  if (!row) return null;
  return {
    carId: row.car_id,
    enabled: row.enabled === 1,
    suspendMin: row.suspend_min,
    suspendAfterIdleMin: row.suspend_after_idle_min,
    reqNotUnlocked: row.req_not_unlocked === 1,
    freeSupercharging: row.free_supercharging === 1,
    lfpBattery: row.lfp_battery === 1,
    usableWhenNewKwh: row.usable_when_new_kwh,
  };
}

export const settingsRoutes = new Hono<{ Bindings: AppEnv }>()
  .get("/settings", async (c) => c.json(await settingsResponse(c.env)))

  .put("/settings", async (c) => {
    const parsed = GlobalPatch.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_request", message: parsed.error.message }, 400);
    const patch = parsed.data;

    // The client explains how to connect R2 before it ever asks for this; the
    // check here is for anything else that does.
    if (patch.documentStorage === "bucket" && !c.env.bucket) {
      return c.json(
        {
          error: "bucket_unavailable",
          message: "This deployment has no R2 bucket. Enable R2 in the Cloudflare dashboard, then deploy again.",
        },
        409,
      );
    }

    const before = await readGlobalSettings(c.env.DB);
    const columns: Record<string, string | undefined> = {
      unit_of_length: patch.unitOfLength,
      unit_of_temperature: patch.unitOfTemperature,
      unit_of_pressure: patch.unitOfPressure,
      currency: patch.currency,
      preferred_range: patch.preferredRange,
      timezone: patch.timezone,
      geocode_language: patch.geocodeLanguage,
      telemetry_level: patch.telemetryLevel,
      document_storage: patch.documentStorage,
    };
    const assignments = Object.entries(columns).filter(([, value]) => value !== undefined);
    if (assignments.length > 0) {
      await c.env.DB.prepare(`UPDATE settings SET ${assignments.map(([col]) => `${col} = ?`).join(", ")} WHERE id = 1`)
        .bind(...assignments.map(([, value]) => value as string))
        .run();
    }

    // Turning telemetry on is the moment "this installation exists" may first
    // be said — the cron would notice within ten minutes, but the person who
    // just opted in deserves the stamp to reflect their choice immediately.
    if (patch.telemetryLevel && patch.telemetryLevel !== "off" && before.telemetryLevel === "off") {
      await recordVersionMilestones(c.env.DB);
    }

    // Efficiency is derived against the preferred range, so it must be redone.
    if (patch.preferredRange && patch.preferredRange !== before.preferredRange) {
      const cars = await c.env.DB.prepare("SELECT id FROM cars").all<{ id: number }>();
      for (const car of cars.results) {
        await new Repo(c.env.DB, car.id).recalculateEfficiency();
      }
    }

    return c.json(await settingsResponse(c.env));
  })

  .get("/cars/:id/settings", async (c) => {
    const carId = Number(c.req.param("id"));
    if (!Number.isInteger(carId)) return c.json({ error: "invalid_car_id" }, 400);
    const settings = await readCarSettings(c.env.DB, carId);
    return settings ? c.json(settings) : c.json({ error: "not_found" }, 404);
  })

  .put("/cars/:id/settings", async (c) => {
    const carId = Number(c.req.param("id"));
    if (!Number.isInteger(carId)) return c.json({ error: "invalid_car_id" }, 400);
    const parsed = CarPatch.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_request", message: parsed.error.message }, 400);
    const patch = parsed.data;

    const columns: Record<string, number | null | undefined> = {
      enabled: patch.enabled === undefined ? undefined : patch.enabled ? 1 : 0,
      suspend_min: patch.suspendMin,
      suspend_after_idle_min: patch.suspendAfterIdleMin,
      req_not_unlocked: patch.reqNotUnlocked === undefined ? undefined : patch.reqNotUnlocked ? 1 : 0,
      free_supercharging: patch.freeSupercharging === undefined ? undefined : patch.freeSupercharging ? 1 : 0,
      lfp_battery: patch.lfpBattery === undefined ? undefined : patch.lfpBattery ? 1 : 0,
      usable_when_new_kwh: patch.usableWhenNewKwh,
    };
    const assignments = Object.entries(columns).filter(([, value]) => value !== undefined);
    if (assignments.length > 0) {
      const result = await c.env.DB.prepare(
        `UPDATE car_settings SET ${assignments.map(([col]) => `${col} = ?`).join(", ")} WHERE car_id = ?`,
      )
        .bind(...assignments.map(([, value]) => value as number | null), carId)
        .run();
      if (!result.meta.changes) return c.json({ error: "not_found" }, 404);
    }

    // Toggling collection has to start or stop the car's logging loop.
    if (patch.enabled !== undefined) {
      const vehicle = c.env.actors.vehicle(carId);
      if (patch.enabled) await vehicle.ensureRunning(carId);
      else await vehicle.stop(carId);
    }

    const settings = await readCarSettings(c.env.DB, carId);
    return settings ? c.json(settings) : c.json({ error: "not_found" }, 404);
  });
