import { Hono } from "hono";
import { z } from "zod";
import type { MqttSettingsDto } from "@shared/api-types";
import { decryptString, encryptString } from "../core/crypto";
import { isValidPrefix, normalizePrefix } from "../core/mqtt";
import type { AppEnv } from "../platform/env";

/**
 * The MQTT card in Settings (docs/mqtt.md): broker, login and topic prefix,
 * stored in the settings row, the password encrypted with ENCRYPTION_KEY.
 * Only the Node server publishes, so on Cloudflare the card is not shown and
 * a change is refused.
 */

interface MqttRow {
  mqtt_enabled: number | null;
  mqtt_url: string | null;
  mqtt_username: string | null;
  mqtt_password_enc: string | null;
  mqtt_prefix: string | null;
}

const MqttPatch = z.object({
  enabled: z.boolean().optional(),
  url: z.string().trim().max(512).optional(),
  username: z.string().max(256).optional(),
  password: z.string().max(512).nullable().optional(),
  prefix: z.string().max(128).optional(),
});

const SCHEMES = new Set(["mqtt:", "mqtts:", "ws:", "wss:"]);

/** Why a broker address will not do, or null when it will. "" is fine: not set yet. */
export function brokerUrlProblem(url: string): string | null {
  if (url === "") return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "Enter the broker as mqtt://host:1883 (or mqtts://, ws://, wss://).";
  }
  if (!SCHEMES.has(parsed.protocol) || parsed.hostname === "") {
    return "Enter the broker as mqtt://host:1883 (or mqtts://, ws://, wss://).";
  }
  // A login in the address would be stored in clear; the password field encrypts it.
  if (parsed.username !== "" || parsed.password !== "") {
    return "Put the user name and password in their own fields, not in the address.";
  }
  return null;
}

/** On only with a broker to publish to, whatever the switch column says. */
function isOn(row: MqttRow | null): boolean {
  return row?.mqtt_enabled === 1 && (row.mqtt_url ?? "") !== "";
}

async function readRow(env: AppEnv): Promise<MqttRow | null> {
  return env.DB.prepare(
    "SELECT mqtt_enabled, mqtt_url, mqtt_username, mqtt_password_enc, mqtt_prefix FROM settings WHERE id = 1",
  ).first<MqttRow>();
}

/** What the publisher connects with, the password decrypted. */
export async function readMqttConfig(env: AppEnv) {
  const row = await readRow(env);
  let password = "";
  if (row?.mqtt_password_enc) {
    try {
      password = await decryptString(env.ENCRYPTION_KEY, row.mqtt_password_enc);
    } catch {
      throw new Error("The stored MQTT password cannot be read (was ENCRYPTION_KEY changed?). Enter it again.");
    }
  }
  return {
    enabled: isOn(row),
    url: row?.mqtt_url ?? "",
    username: row?.mqtt_username ?? "",
    password,
    prefix: normalizePrefix(row?.mqtt_prefix),
  };
}

async function mqttResponse(env: AppEnv): Promise<MqttSettingsDto> {
  const row = await readRow(env);
  return {
    available: env.mqtt !== null,
    enabled: isOn(row),
    url: row?.mqtt_url ?? "",
    username: row?.mqtt_username ?? "",
    passwordSet: Boolean(row?.mqtt_password_enc),
    prefix: normalizePrefix(row?.mqtt_prefix),
    status: env.mqtt?.status() ?? null,
  };
}

export const mqttRoutes = new Hono<{ Bindings: AppEnv }>()
  .get("/mqtt", async (c) => c.json(await mqttResponse(c.env)))

  .put("/mqtt", async (c) => {
    if (!c.env.mqtt) {
      return c.json({ error: "mqtt_unavailable", message: "MQTT is available when EVBook runs on Node." }, 409);
    }
    const parsed = MqttPatch.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_settings", message: parsed.error.message }, 400);
    const patch = parsed.data;

    if (patch.url !== undefined) {
      const problem = brokerUrlProblem(patch.url);
      if (problem) return c.json({ error: "invalid_url", message: problem }, 400);
    }
    if (patch.prefix !== undefined && !isValidPrefix(normalizePrefix(patch.prefix))) {
      return c.json(
        {
          error: "invalid_prefix",
          message: "A topic prefix cannot start with $, contain # or +, or have an empty level (//).",
        },
        400,
      );
    }
    const before = await readRow(c.env);
    const url = patch.url ?? before?.mqtt_url ?? "";
    if (patch.enabled === true && url === "") {
      return c.json({ error: "invalid_url", message: "Enter the broker before turning MQTT on." }, 400);
    }

    const columns: Record<string, string | number | null | undefined> = {
      // Clearing the broker turns MQTT off rather than leaving a switch on with nothing behind it.
      mqtt_enabled: patch.enabled === undefined ? (patch.url === "" ? 0 : undefined) : patch.enabled ? 1 : 0,
      mqtt_url: patch.url,
      mqtt_username: patch.username?.trim(),
      mqtt_password_enc:
        patch.password === undefined
          ? undefined
          : patch.password === null || patch.password === ""
            ? null
            : await encryptString(c.env.ENCRYPTION_KEY, patch.password),
      mqtt_prefix: patch.prefix === undefined ? undefined : normalizePrefix(patch.prefix),
    };
    const assignments = Object.entries(columns).filter(([, value]) => value !== undefined);
    if (assignments.length > 0) {
      await c.env.DB.prepare(`UPDATE settings SET ${assignments.map(([col]) => `${col} = ?`).join(", ")} WHERE id = 1`)
        .bind(...assignments.map(([, value]) => value as string | number | null))
        .run();
    }

    await c.env.mqtt.reload();
    return c.json(await mqttResponse(c.env));
  });
