import type { CarSummaryDto, MqttStatusDto } from "@shared/api-types";
import { carTopics, type CarExtras } from "../../../core/mqtt";
import type { Connect, MqttConnection } from "./client";

/**
 * Sends every car's summary to an MQTT broker, every 30 seconds, and only what
 * changed since the last send. Retained, so a subscriber that connects later
 * gets the current values at once.
 *
 * It reads what EVBook already has (`MqttSource`) and never asks a car for
 * anything, so it costs the car no wake-ups and the provider no requests. The
 * source is an interface because it will change: today it reads the live
 * summaries, later the summary snapshot the HA proposal (§1.2) stores.
 *
 * The settings are read again on every pass, so a change in Settings takes
 * effect within one pass, or at once through `reload()`. A changed broker,
 * login or prefix means a new connection; every (re)connect sends everything
 * again, because the broker may have lost its retained messages.
 */

export interface MqttConfig {
  enabled: boolean;
  url: string;
  username: string;
  password: string;
  prefix: string;
}

export interface MqttCar {
  id: number;
  summary: CarSummaryDto;
  extras: CarExtras;
}

export interface MqttSource {
  cars(): Promise<MqttCar[]>;
}

export interface MqttControl {
  status(): MqttStatusDto;
  /** Read the settings again and publish now, after Settings changed them. */
  reload(): Promise<void>;
  /** Says offline and disconnects. */
  stop(): Promise<void>;
}

export interface PublisherOptions {
  config: () => Promise<MqttConfig>;
  source: MqttSource;
  connect: Connect;
  intervalMs?: number;
  now?: () => number;
}

export const PUBLISH_INTERVAL_MS = 30_000;

export function startMqttPublisher(options: PublisherOptions): MqttControl {
  const now = options.now ?? Date.now;
  const intervalMs = options.intervalMs ?? PUBLISH_INTERVAL_MS;

  let connection: MqttConnection | null = null;
  let connectionKey: string | null = null;
  let prefix = "evbook";
  /** Full topic → payload last sent on the current connection. */
  const sent = new Map<string, string>();
  let state: MqttStatusDto = { state: "off", error: null, since: null, lastPublishAt: null };
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<void> | null = null;
  let again = false;
  let stopped = false;

  const setState = (next: MqttStatusDto["state"], error: string | null = null) => {
    if (state.state !== next) state = { ...state, state: next, since: now() };
    state = { ...state, error };
  };

  const disconnect = async () => {
    const old = connection;
    connection = null;
    connectionKey = null;
    sent.clear();
    if (old) await old.end().catch(() => undefined);
  };

  const pass = async () => {
    const config = await options.config();
    if (!config.enabled || config.url === "") {
      await disconnect();
      setState("off");
      return;
    }

    const key = JSON.stringify([config.url, config.username, config.password, config.prefix]);
    if (key !== connectionKey) {
      await disconnect();
      prefix = config.prefix;
      setState("connecting");
      const fresh = options.connect({
        url: config.url,
        username: config.username,
        password: config.password,
        statusTopic: `${config.prefix}/status`,
      });
      fresh.onConnect(() => {
        if (connection !== fresh) return;
        sent.clear();
        setState("connected");
        void run();
      });
      fresh.onError((message) => {
        if (connection === fresh) setState("error", message);
      });
      fresh.onClose(() => {
        if (connection === fresh && state.state === "connected") setState("connecting");
      });
      connection = fresh;
      connectionKey = key;
    }

    const current = connection;
    if (!current?.connected) return;

    for (const car of await options.source.cars()) {
      for (const [name, payload] of carTopics(car.summary, car.extras)) {
        const topic = `${prefix}/cars/${car.id}/${name}`;
        if (sent.get(topic) === payload) continue;
        await current.publish(topic, payload);
        sent.set(topic, payload);
        state = { ...state, lastPublishAt: now() };
      }
    }
  };

  /** One pass at a time; a call during a pass runs one more right after it. */
  const run = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (running) {
      again = true;
      return running;
    }
    running = pass()
      .catch((error: unknown) => {
        setState("error", error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        running = null;
        if (again) {
          again = false;
          void run();
        }
      });
    return running;
  };

  const arm = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      arm();
      void run();
    }, intervalMs);
  };

  void run();
  arm();

  return {
    status: () => state,
    reload: () => run(),
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await running;
      await disconnect();
    },
  };
}
