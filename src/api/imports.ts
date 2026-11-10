import { Hono } from "hono";
import { listSources } from "../core/import/sources";
import type { ImportJobDto, ImportSourceDto } from "@shared/api-types";
import type { AppEnv } from "../platform/env";
import { DEMO_REFUSAL, isDemo } from "./demo";

/**
 * Upload and monitor a history import.
 *
 * The upload streams straight into `ImportDO`, which then works through it on
 * alarms — so this handler returns as soon as the bytes are parked, and the SPA
 * polls for progress. One import at a time, which keeps the story simple and
 * stops two of them fighting over the same car.
 */

/** Generous for a vendor export (Tessie's two-year zip is about 10 MB). */
const MAX_UPLOAD_BYTES = 96 * 1024 * 1024;

/** Bytes per RPC into the Durable Object. */
const SLICE_BYTES = 1024 * 1024;

function importer(env: AppEnv) {
  return env.actors.importer();
}

function numberParam(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export const importRoutes = new Hono<{ Bindings: AppEnv }>()
  /** What this build can read. */
  .get("/imports/sources", (c) => {
    const sources: ImportSourceDto[] = listSources().map((source) => ({
      id: source.id,
      label: source.label,
      describe: source.describe,
      howToExport: source.howToExport ?? null,
    }));
    return c.json(sources);
  })

  .get("/imports/current", async (c) => {
    const job = await importer(c.env).status();
    return c.json<ImportJobDto | null>(job);
  })

  /** Stops a running import, keeping the upload so it can be resumed. */
  .delete("/imports/current", async (c) => {
    if (isDemo(c.env)) return c.json(DEMO_REFUSAL, 403);
    const stub = importer(c.env);
    if (c.req.query("discard") === "true") await stub.discard();
    else await stub.cancel();
    return c.body(null, 204);
  })

  /** Carries on from where a stopped or failed import got to. */
  .post("/imports/current/resume", async (c) => {
    if (isDemo(c.env)) return c.json(DEMO_REFUSAL, 403);
    try {
      return c.json(await importer(c.env).resume(), 202);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: "not_resumable", message }, 409);
    }
  })

  /**
   * The export itself, as the raw request body. Query parameters carry the
   * options the CLI takes as flags.
   */
  .post("/imports", async (c) => {
    if (isDemo(c.env)) return c.json(DEMO_REFUSAL, 403);
    const stub = importer(c.env);
    const existing = await stub.status();
    if (existing && (existing.phase === "importing" || existing.phase === "uploading")) {
      // Swallow the body we are not going to use. Cancelling it would say the
      // same thing in fewer bytes, but workerd then logs an uncaught
      // "can't read from request stream" for the response outrunning the
      // stream, which reads as a failure in the test output. The bytes are
      // bounded by the platform's request cap and cost a rare mistaken upload.
      await c.req.raw.body?.pipeTo(new WritableStream());
      return c.json({ error: "import_in_progress", message: "An import is already running." }, 409);
    }

    const body = c.req.raw.body;
    if (!body) return c.json({ error: "empty_body", message: "Send the export as the request body." }, 400);

    const label = c.req.query("filename") ?? "export.zip";
    await stub.begin(label);

    const reader = body.getReader();
    let pending: Uint8Array[] = [];
    let pendingBytes = 0;
    let total = 0;

    const flush = async () => {
      if (pendingBytes === 0) return;
      const slice = new Uint8Array(pendingBytes);
      let at = 0;
      for (const part of pending) {
        slice.set(part, at);
        at += part.length;
      }
      pending = [];
      pendingBytes = 0;
      await stub.append(slice);
    };

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > MAX_UPLOAD_BYTES) {
          await reader.cancel();
          await stub.cancel();
          return c.json(
            { error: "too_large", message: `Exports over ${MAX_UPLOAD_BYTES >> 20} MB are not accepted.` },
            413,
          );
        }
        pending.push(value);
        pendingBytes += value.byteLength;
        if (pendingBytes >= SLICE_BYTES) await flush();
      }
      await flush();
    } catch (error) {
      await stub.cancel();
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: "upload_failed", message }, 400);
    }

    if (total === 0) {
      await stub.cancel();
      return c.json({ error: "empty_body", message: "The upload was empty." }, 400);
    }

    const job = await stub.start({
      sourceId: c.req.query("source"),
      vin: c.req.query("vin"),
      carId: numberParam(c.req.query("carId")),
      carName: c.req.query("name"),
      since: numberParam(c.req.query("since")),
      until: numberParam(c.req.query("until")),
      geocode: c.req.query("geocode") === "true",
      geocodeRadiusMeters: numberParam(c.req.query("geocodeRadius")),
    });
    return c.json(job, job.phase === "failed" ? 422 : 202);
  });
