# evbook-telemetry — the project's collector

The Worker that opt-in EVBook installations export telemetry to
(`https://telemetry.evbook.app/v1/logs`, the default in
[`shared/telemetry.ts`](../shared/telemetry.ts)). What an instance sends, and
when, is in [docs/telemetry.md](../docs/telemetry.md). This Worker lives only on
the project's Cloudflare account; installations never deploy it.

## What it does

`POST /v1/logs` takes the OTLP/JSON batch an instance's cron flushes, checks it
is EVBook (`service.name`, a UUID instance id, a version, at most 200 records,
values cut at 4 KB, 1 MB body, 20 requests a minute per address) and then, per
event:

| Where | Kept | What for |
|---|---|---|
| **Workers Logs** — one structured `console.log` | 7 days | Every field, searchable: crashes, feedback, survey answers, the full stats |
| **Analytics Engine** — dataset `evbook_telemetry` | 3 months | Counting: installations, versions, car models, over time |

Anything else gets a 400, which the instance retries ten times and then drops.
`GET /health` answers `{"ok":true}`.

## Looking at it

**Logs:** dashboard → Workers & Pages → `evbook-telemetry` → Observability (or
the account-wide Observability → Query Builder). Filter on `event`,
`instance`, `version`, `model`… — every field of the event is indexed.

**Counts:** Analytics Engine SQL, with an API token that has *Account
Analytics: Read*. `wrangler login`'s OAuth token works too:

```bash
curl -s "https://api.cloudflare.com/client/v4/accounts/239c7c818ff717ce0838e129b2b57527/analytics_engine/sql" \
  -H "Authorization: Bearer $TOKEN" --data "<query>"
```

Column map (append-only; [`src/ingest.ts`](src/ingest.ts) `toDataPoint`):
`index1` instance, `blob1` event, `blob2` version, `blob3` severity, `blob4`
model, `blob5` firmware, `blob6` updated-from version; `double1` model year,
`double2` odometer km, `double3` capacity kWh, `double4` degradation %,
`double5` degradation from new %, `double6..9` rows of cars, drives, charging
processes, positions.

Analytics Engine samples bursts: a batch of 100 events from one instance can be
stored as 10 rows, each with `_sample_interval = 10`. Count with
`SUM(_sample_interval)`, never `COUNT()`. `COUNT(DISTINCT index1)` is safe,
because sampling keeps whole instances.

```sql
-- Active installations (anything reported) in the last 30 days, by version
SELECT blob2 AS version, COUNT(DISTINCT index1) AS installations
FROM evbook_telemetry WHERE timestamp > NOW() - INTERVAL '30' DAY
GROUP BY version ORDER BY installations DESC

-- New installations per day
SELECT toStartOfDay(timestamp) AS day, COUNT(DISTINCT index1) AS installs
FROM evbook_telemetry WHERE blob1 = 'app.install' GROUP BY day ORDER BY day

-- Cars by model (latest daily snapshot window)
SELECT blob4 AS model, SUM(_sample_interval) AS cars,
       SUM(_sample_interval * double4) / SUM(_sample_interval) AS avg_degradation
FROM evbook_telemetry WHERE blob1 = 'vehicle.stats' AND timestamp > NOW() - INTERVAL '1' DAY
GROUP BY model

-- Errors per version this week
SELECT blob2 AS version, blob1 AS event, SUM(_sample_interval) AS n
FROM evbook_telemetry WHERE blob3 = 'error' AND timestamp > NOW() - INTERVAL '7' DAY
GROUP BY version, event
```

## Cost

All of it fits inside the $5 Workers Paid plan's allowances with a wide margin.
An opted-in installation flushes at most once per ten-minute cron block and only
when it has something queued. In practice that means a handful of requests a day:
one daily stats batch, plus the occasional install, update or crash.

| Allowance (Paid) | Included | At 1 000 opted-in installations |
|---|---|---|
| Worker requests | 10 M / month | ~30–150 k |
| Workers Logs events (until 2026-12-01) | 20 M / month | ~150 k |
| Observability ingestion (from 2026-12-01) | 50 GB / month | well under 1 GB |
| Analytics Engine data points | 10 M / month | ~150 k |
| Analytics Engine reads | 1 M / month | what you query by hand |
| Rate limiting binding | no charge | — |

Invocation logs and traces are off in [`wrangler.jsonc`](wrangler.jsonc), so
the only log lines are the events themselves. Abuse is bounded by the rate
limit and the body cap; Cloudflare charges $0.30 per extra million requests
beyond the included 10 M.

## Deploying

Wrangler, from outside the repository root. The root `.env` holds a DNS-only
`CLOUDFLARE_API_TOKEN` that wrangler would otherwise pick up:

```bash
env -u CLOUDFLARE_API_TOKEN /path/to/evbook/node_modules/.bin/wrangler deploy --config /path/to/evbook/collector/wrangler.jsonc
```

The spec is `src/ingest.test.ts`, run by `bun test`. It feeds the
parser the payload that `src/core/telemetry.ts` actually builds, so a change to
either side that breaks the other fails there.
