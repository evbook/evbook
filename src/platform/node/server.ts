import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { serve, type ServerType } from "@hono/node-server";
import { app } from "../../app";
import { readMqttConfig } from "../../api/mqtt";
import type { AppEnv } from "../env";
import type { Actors } from "../ports";
import { createNodeActors, type NodeActors } from "./actors";
import { fileAssets } from "./assets";
import { fileBlobs } from "./blobs";
import { loadConfig, type NodeConfig } from "./config";
import { startCron } from "./cron";
import { connectMqtt } from "./mqtt/client";
import { startMqttPublisher } from "./mqtt/publisher";
import { liveSummaries } from "./mqtt/source";
import { runMigrations } from "./migrate";
import { forwardedClient } from "./proxy";
import { openSqlite } from "./sqlite";

/**
 * Assembles the whole runtime: SQLite, migrations, the actor runtime, the
 * HTTP server and the cron — the Node equivalent of everything wrangler.jsonc
 * wires up on Cloudflare. `startServer` is the programmatic form the smoke
 * tests boot; `main.ts` is the process entrypoint around it.
 */

export interface RunningServer {
  port: number;
  env: AppEnv;
  /** Graceful: stops the clock and the listener, drains actors, closes the DB. */
  close(): Promise<void>;
}

export interface StartOptions {
  config?: Partial<NodeConfig>;
  /** Skip the cron (tests drive the clock themselves). */
  cron?: boolean;
  /** Skip the MQTT publisher (tests that do not need it). */
  mqtt?: boolean;
}

export async function startServer(options: StartOptions = {}): Promise<RunningServer> {
  const config: NodeConfig = { ...loadConfig(), ...options.config };

  mkdirSync(dirname(config.DATABASE_PATH), { recursive: true });
  const database = openSqlite(config.DATABASE_PATH);

  const applied = runMigrations(database.sqlite, config.MIGRATIONS_DIR);
  if (applied.length > 0) console.log(`[db] applied ${applied.length} migration(s): ${applied.join(", ")}`);

  // The env→actors cycle resolves here: actors are created lazily on first
  // use, by which point the assignment below has run.
  const peers = new WeakMap<Request, string | undefined>();
  const env: AppEnv = {
    ...config,
    platform: "node",
    DB: database.db,
    assets: fileAssets(config.ASSETS_DIR),
    // The directory is created on first put, so a deployment that never
    // uploads a document never grows one.
    bucket: { kind: "files", store: fileBlobs(config.BLOBS_DIR) },
    actors: undefined as unknown as Actors,
    mqtt: null,
    clientAddress: (request) => forwardedClient(request, config.TRUST_PROXY === "true", peers.get(request)),
  };
  const actors: NodeActors = createNodeActors(database.sqlite, env);
  env.actors = actors;
  actors.recoverAlarms();
  // Idle until MQTT is turned on in Settings; then it publishes every 30 s.
  const mqtt =
    options.mqtt === false
      ? null
      : startMqttPublisher({ config: () => readMqttConfig(env), source: liveSummaries(env), connect: connectMqtt });
  env.mqtt = mqtt;

  const server: ServerType = serve({
    fetch: (request, http) => {
      // The socket's address, which a Request does not carry, for clientAddress.
      peers.set(request, http.incoming.socket.remoteAddress);
      return app.fetch(request, env);
    },
    port: config.PORT,
    hostname: process.env.HOST ?? "0.0.0.0",
  });
  await new Promise<void>((resolve) => server.on("listening", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : config.PORT;

  const cron = options.cron === false ? null : startCron(env);

  let closed = false;
  return {
    port,
    env,
    async close() {
      if (closed) return;
      closed = true;
      cron?.stop();
      await mqtt?.stop();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      await actors.shutdown();
      database.close();
    },
  };
}
