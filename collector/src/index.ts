import { parseOtlpLogs, Rejected, toDataPoint } from "./ingest";

/**
 * evbook-telemetry: the collector opt-in EVBook installations export to
 * (`DEFAULT_TELEMETRY_ENDPOINT` in shared/telemetry.ts). It runs on the
 * project's own Cloudflare account and keeps nothing itself:
 *
 * - every event is one structured `console.log`, which Workers Logs indexes
 *   field by field — the dashboard's Observability tab and Query Builder are
 *   the viewer (seven days);
 * - a narrow, countable copy goes to Analytics Engine (three months), for
 *   "how many installations, on which versions, with which cars" over time.
 *
 * Both are inside the Workers Paid allowances by orders of magnitude at
 * EVBook's scale — see collector/README.md for the arithmetic.
 */

interface Env {
  EVENTS: AnalyticsEngineDataset;
  LIMITER: RateLimit;
}

/** An instance sends at most ~100 rows of a few KB each; anything far beyond is not EVBook. */
const MAX_BODY_BYTES = 1_000_000;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return json(200, { ok: true });
    if (url.pathname !== "/v1/logs") return json(404, { error: "not_found" });
    if (request.method !== "POST") return json(405, { error: "method_not_allowed" });

    // Per sending address: instances flush from the cron every ten minutes, so
    // anything near the limit is a loop or abuse, never an installation.
    const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
    const { success } = await env.LIMITER.limit({ key: ip });
    if (!success) return json(429, { error: "rate_limited" });

    const declared = Number(request.headers.get("content-length") ?? "0");
    if (declared > MAX_BODY_BYTES) return json(413, { error: "too_large" });
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) return json(413, { error: "too_large" });

    let events;
    try {
      events = parseOtlpLogs(JSON.parse(text));
    } catch (error) {
      // 4xx tells the instance to stop retrying this batch after its ten tries.
      const reason = error instanceof Rejected ? error.message : "invalid_json";
      console.warn({ rejected: reason });
      return json(400, { error: reason });
    }

    for (const event of events) {
      console.log({
        event: event.event,
        instance: event.instance,
        version: event.version,
        severity: event.severity,
        recordedAt: new Date(event.time).toISOString(),
        ...event.attributes,
      });
      env.EVENTS.writeDataPoint(toDataPoint(event));
    }
    // OTLP/HTTP success: an empty partialSuccess means every record was taken.
    return json(200, { partialSuccess: {} });
  },
} satisfies ExportedHandler<Env>;
