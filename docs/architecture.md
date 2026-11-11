# EVBook — Architecture

This describes the design as it is built. Where it names a choice that was
dropped it says so, rather than being quietly wrong: the reasoning that led
somewhere else is worth as much as the reasoning that held.

## Overview

```
Browser (React SPA) ──► Hono app ──► SQL database (D1 / node:sqlite)
                           │  reads: lists, stats, detail
                           │
                           ├─ RPC ─► VehicleActor (one per car)
                           │           state machine ──► database writes
                           ├─ RPC ─► AuthActor (token store + refresh)
                           ├─ RPC ─► ImportActor (history import, slice by slice)
                           ├─ blobs ─► R2 / a directory (glovebox documents)
                           └─ cron (every minute): poll parked cars;
                                every 10 min: repairs, update check, telemetry
                                       │
              Tesla Owner API   OSM Nominatim   Open-Meteo   GitHub
```

One actor per car runs the state machine, buffers position writes and flushes
them in batches, so a 2.5-second drive loop costs about two database writes a
minute. The reducer in [`src/core/fsm.ts`](../src/core/fsm.ts) is pure —
`(state, event) → {next, effects}` — which is what makes its scenarios
portable as unit tests.

The hosting provider is a layer, not the architecture. The actors in
[`src/actors/`](../src/actors/) are plain classes over small ports declared in
[`src/platform/ports.ts`](../src/platform/ports.ts) — a KV-with-alarm
`ActorStorage`, a `SqlDatabase` that is structurally the D1 surface, and a
`BlobStore` — and [`src/app.ts`](../src/app.ts) composes the whole app from an
`AppEnv`. On Cloudflare (`src/index.ts`, `src/do/`,
`src/platform/cloudflare/`) the actors run as Durable Objects, the database is
D1 and blobs go to R2; on a VPS (`src/platform/node/`) the same actors run in
one process behind per-actor mutexes, the database is `node:sqlite` and blobs
are plain files. Adding a host means implementing those ports, not touching
the app.

The same reducer is what replays an imported history, so a drive logged live and
a drive imported from another service are cut and aggregated by identical
rules — [import.md](./import.md) has that pipeline.

---

## 1. Stack

| Layer | Choice | Notes |
|---|---|---|
| Runtime | Cloudflare Workers + Durable Objects, or Node (`node:sqlite`) | One app, two hosts; see §2.1 |
| Language | TypeScript (strict) | Single language everywhere |
| HTTP framework | Hono | Small, runs unchanged on Workers and on `@hono/node-server` |
| Database | D1 (SQLite) on Cloudflare, `node:sqlite` on Node | Single database for all durable data; see §3.1 |
| ORM / migrations | None — hand-written SQL | Migrations are SQL files in `migrations/`, applied at startup (§3.10). Drizzle was the plan and was dropped: every read here is an aggregate with a window, a bucket width and a nulls-last sort, which is the shape query builders are worst at, and the queries are the part of this app most worth reading as SQL |
| Blob storage | the database by default; optionally R2 on Cloudflare, a directory on Node | Glovebox documents only (§8.2) |
| Front-end | React 19 + Vite SPA, React Router | No SSR; the server answers `/api/*` and serves the built files |
| UI kit | Tailwind CSS 4 + shadcn/ui-style components in `app/components/ui/` | |
| Charts | Recharts, behind one component (§3.8) | |
| Tables | Plain `<table>` with shadcn styling | TanStack Table was the plan and was not needed: sorting, filtering and paging are all done in SQL and carried in the URL, so there is no client-side table state for a table library to hold |
| Data fetching | TanStack Query | Polling for live summaries |
| Maps | Leaflet + OSM raster tiles | |
| Validation | Zod | Tesla API payloads, API inputs, settings |
| Testing | `bun test`, Vitest on `@cloudflare/vitest-pool-workers` for what needs workerd, Playwright | See [testing.md](./testing.md) |
| Deploy | `cf`, the Cloudflare CLI (`cloudflare.config.ts`; wrangler and `wrangler.jsonc` kept in step), or Docker / a Node process | See [cloudflare-cli.md](./cloudflare-cli.md), [vps.md](./vps.md) and [updating.md](./updating.md) |

On Cloudflare, Durable Objects (SQLite-backed), D1, R2 and cron triggers are
all available on the Workers Free plan, and the polling design (§3.9) is built
to keep a car or two inside its allowances.

## 2. Architecture

```
                     ┌────────────────────────────────────────────────┐
                     │ Cloudflare Worker (single deployment)          │
 Browser (SPA) ────► │  Hono API  ──────────────► D1 (SQLite)         │
  static assets ◄─── │  /api/v1/*        reads: lists, stats, detail  │
                     │      │                                         │
                     │      │ RPC (summary, suspend/resume, wake, …)  │
                     │      ▼                                         │
                     │  VehicleDO (one per car) ────► D1 (writes)     │
                     │   · state machine                              │
                     │   · alarm while driving/charging/waking        │
                     │   · fetches Tesla Owner API                    │
                     │   · buffers positions, flushes batched         │
                     │   · own storage: FSM state, token cache, buffer│
                     │  AuthDO (singleton)   ImportDO (singleton)     │
                     │                                                │
                     │  Cron (every minute): poll clock for idle cars │
                     │       (every 10 min): repairs, update check,   │
                     │                       telemetry export         │
                     └────────────────────────────────────────────────┘
                          │              │             │          │
                          ▼              ▼             ▼          ▼
                   Tesla Owner API  OSM Nominatim  Open-Meteo   GitHub
                                    (addresses)    (elevation)  (releases)
```

- **App (stateless)**: serves the SPA, authenticates (session cookie vs
  `APP_PASSWORD`), answers all read queries straight from the database, and
  proxies live-state requests and commands to the car's actor.
- **VehicleActor (stateful)**: the port of TeslaMate's per-car `GenStateMachine`.
  Holds its working state (FSM state, last response, write buffer, breaker
  counters, a cached access token) in its own storage so eviction is harmless,
  and writes rows to the database. It polls on one of two clocks — its own
  alarm while a short cadence is needed, the cron otherwise (§3.9).
- **AuthActor (singleton)**: owns the Tesla token pair and the refresh schedule
  (one refresh timer for the whole account, like TeslaMate's `Api` GenServer +
  ETS). Vehicle actors fetch a token from it and cache it in their own storage
  for up to 15 minutes, encrypted, so a poll does not wake a second object.
- **ImportActor (singleton)**: runs one history import at a time, advancing on
  its alarm a slice per tick so the work survives any single request's limits
  (§8.1).
- **Cron** (`* * * * *`, `runScheduled` in `src/app.ts`): every minute, polls
  every enabled car whose deadline (`cars.next_due_at`) has come due. On every
  tenth minute it also closes sessions that were abandoned, repairs missing
  addresses, POIs and drive origins (all throttled to Nominatim's one request a
  second), checks for a newer release at most once a day, and exports opt-in
  telemetry.

### 2.1 Two hosts

| | Cloudflare | Node |
|---|---|---|
| Entrypoint | `src/index.ts` | `src/platform/node/main.ts` (`server.ts` assembles it) |
| Actors | Durable Objects; `src/do/*` are thin shells delegating each RPC to `src/actors/*` | `src/platform/node/actors.ts`: in-process objects, one promise-chain mutex each |
| Actor storage | `ctx.storage` (satisfies `ActorStorage` as-is) | `actor_kv` and `actor_alarms` tables in the same SQLite file, bootstrap DDL rather than migrations |
| Alarms | DO alarms | one `setTimeout` per actor, re-armed from `actor_alarms` at boot |
| Database | D1 | `node:sqlite` (`sqlite.ts`), `batch()` as `BEGIN…COMMIT`, foreign keys on |
| Blobs | D1 (`document_blobs`), or R2 bucket `BLOBS` when bound | SQLite, or files under `BLOBS_DIR` |
| Cron | wrangler trigger | `cron.ts`: a `setTimeout` re-aligned to each minute boundary |
| Config | wrangler vars + secrets | `process.env` (`config.ts`), same names, plus `PORT`, `DATABASE_PATH`, `ASSETS_DIR`, `BLOBS_DIR`, `MIGRATIONS_DIR` |

`tsconfig.node.json` compiles everything under `src/api`, `src/db`, `src/core`,
`src/actors` and `shared/` without Cloudflare or Node types in scope, which is
what keeps the app honest about the ports. Every configuration value defaults
to the empty string, which the app reads as "not configured"; the two secrets
being empty is what sends a fresh install to the setup screen.

## 3. Key design decisions

### 3.1 One SQL database (not per-actor SQLite)

Considered: keep all data in each vehicle actor's own SQLite storage.
**Chosen: one shared database.** Rationale:

- Analytics pages need cross-car queries (statistics, trips) and ad-hoc access;
  with per-actor SQLite every read goes through RPC and cross-car means fan-out.
- Tooling: `wrangler d1` console, exports and Time Travel on Cloudflare; a
  single file to copy on Node.
- D1's lack of interactive transactions is acceptable: every multi-statement
  write in TeslaMate (drive close, charge complete, geofence re-apply) maps to a
  `batch()` (atomic on both hosts) or a single statement with subqueries.
- The actor still uses its **own** storage for hot, transient state (FSM state,
  position write buffer), so the database sees batched, low-rate writes.

### 3.2 Polling, not streaming

EVBook ports TeslaMate's `use_streaming_api: false` mode, which is a complete,
proven configuration. The streaming WebSocket (1 Hz, and the MCU2
`pre_online_check` fake-wake filter) is not used: an outbound WebSocket keeps a
Durable Object awake continuously (client sockets don't hibernate), which costs
duration around the clock and complicates the FSM. Consequences:

- Drive fidelity is 2.5 s samples instead of 1 Hz (identical to TeslaMate
  non-streaming).
- A parked or sleeping car is probed once a minute, and a wake needs a second
  probe 15 s later before data is fetched (below), so the first stretch of a
  drive is not sampled. The drive's origin is reconstructed afterwards from the
  last parked position when the odometer confirms the gap
  ([`src/core/driveOrigin.ts`](../src/core/driveOrigin.ts)).
- MCU2 hourly fake-online blips: `vehicle_data` is **not** called on the first
  "online" probe after asleep/offline; two consecutive online probes
  (`INTERVALS.wakeConfirm`, 15 s apart) are required. A suspended car, already
  known to be awake, is probed and then fetched. This deviates from TeslaMate
  deliberately — cheaper than the stream-based probe, and it errs on the side of
  never waking the car.

### 3.3 Time, numbers, units

- **Timestamps**: INTEGER Unix epoch **milliseconds**, UTC, everywhere. Column
  suffix `_at`.
- **Timezone**: user setting (IANA name) stored in settings. A fresh install
  holds `UTC` with `timezone_chosen = 0`; the web app's first visit replaces it
  with the browser's zone ([`useSeedTimezone`](../app/hooks/useSeedTimezone.ts)),
  and any save from Settings marks it chosen. All period
  bucketing (day/week/month/year) is computed in TS
  ([`shared/timeBuckets.ts`](../shared/timeBuckets.ts)) with `Intl.DateTimeFormat`
  by generating per-bucket UTC ranges, then aggregating in SQL per range. Tested
  across DST transitions. (SQLite has no tz database — never bucket in SQL.) The
  module is shared because the date-range picker snaps to the same boundaries.
- **Decimals**: SQLite REAL for telemetry; **cost as INTEGER minor units**
  (`cost_cents`, `session_fee_cents`) to avoid float money — the API carries
  them as integers too; tariff rates (in the `geofences.tariff` JSON) as major units.
- **Currency**: one code for the whole account (`settings.currency`, default
  EUR), applied to every car. No amount carries a currency of its own, so this
  is a display label — switching it relabels history, it never converts.
  `money()`/`rate()` in `app/lib/format.ts` are the only places a figure
  acquires a symbol.
- **Units**: store SI (km, °C, bar, kW, kWh) at write time exactly like
  TeslaMate (`src/core/convert.ts` ports its `Convert` module — mph→km/h,
  miles→km with `0.62137119223733`, °F↔°C, psi↔bar). All display conversion
  happens in the front-end from user settings.

### 3.4 Geofence matching without `earthdistance`

[`src/core/geo/geofence.ts`](../src/core/geo/geofence.ts) ports
`within_geofence?` as a bounding-box prefilter (box derived from the radius in
metres-per-degree at the geofence's latitude) plus an exact haversine test in
TS; the nearest match wins. Geofence counts are tiny, so even a full scan per
lookup is fine — correctness over cleverness. Editing a geofence re-applies
matches to drives and charges in batches (TeslaMate's known alias bug in
`apply_geofence` is not replicated).

### 3.5 Secrets & token storage

- `ENCRYPTION_KEY` (secret) → AES-256-GCM via `crypto.subtle`
  ([`src/core/crypto.ts`](../src/core/crypto.ts)).
- Tesla access and refresh tokens are encrypted with it and stored in the auth
  actor's storage, mirrored best-effort to the `tokens` table so a full export
  includes them. Losing or changing the key means signing in to Tesla again;
  logged history is unaffected.
- `APP_PASSWORD` (secret) → constant-time compare → signed session cookie
  (HMAC with `ENCRYPTION_KEY`), 30-day expiry. Everything under `/api/v1/*`
  except `/session` and `/auth/login` requires it.
- `DEV_AUTOLOGIN=true` skips the password, but only for requests to a loopback
  host, so it stays inert in a deployment.
- Tokens are pasted into the app's own UI. The **Token Helper** browser
  extension (on the Chrome Web Store, maintained outside this repository) is one way to obtain them: it runs Tesla's PKCE
  sign-in for the `ownerapi` client in a tab it opened, catches the
  `tesla://auth/callback` redirect, and exchanges the code itself, so the code
  and tokens go only between Tesla and the user.

### 3.6 Write-volume budget

From TeslaMate's measured write patterns (polling mode):

| Situation | Rows/min | Notes |
|---|---|---|
| Driving | ~24 positions | 2.5 s poll |
| Charging | 3–12 charges + ~0.2 positions | poll = clamp(round(250/kW), 5..20) s |
| Online idle | ~0.2 positions | 5-min position heartbeat |
| Asleep/suspended | ~0 | state probes only, no rows |

Worst realistic day (4 h driving + 2 h DC charging): ≈ 7,500 rows — well inside
D1's free allowance. The vehicle actor buffers position rows in its own storage
and flushes them in batches of ≤ 25 rows / ≤ 30 s (any non-position effect, such
as a drive close, forces a flush first), so the database sees ~2 writes/min while
driving. **The buffer means a crashed actor loses ≤ 30 s of positions —
acceptable.**

### 3.7 Live updates to the UI

TanStack Query polls `GET /api/v1/summaries` while the tab is visible. The
server answers from each car's actor (`getSummary`), which builds the summary
from its stored state without touching Tesla. In demo mode the summaries are
read from the seeded database instead.

Each poll costs a Worker request plus one actor (Durable Object) request per
car, so the cadence follows the busiest car rather than being fixed
(`app/lib/liveRefresh.ts`): 5 s while one is driving or charging, 15 s while
one is awake, 30 s when all are asleep or offline — never faster than the
actor itself refreshes. A Wake or Resume holds the 5 s cadence for 90 s so the
card catches up promptly.

### 3.8 Charts: one scale per unit, and no forced zero

Every chart in the app is one component, `app/components/SeriesChart.tsx`, so these
hold everywhere at once. The scale arithmetic is `app/lib/axis.ts` and the trend fit is
`app/lib/smooth.ts`, both tested on their own.

- **Two units, two scales.** A series goes on the right (`axis: "right"`) whenever it is
  measured in something the other series is not — kWh against km, cost against
  kWh/100 km. Sharing one scale between them makes the smaller quantity a flat
  line along the floor, which reads as "nothing happened" when the truth is "different
  units". **This is the preferred shape for comparing how two quantities move together
  over the same x-axis.**
- **Same unit, one scale.** Inside vs outside temperature, and anything else quoted in
  the same unit, stays on a single axis — there the point *is* that one number is higher
  than the other, and splitting the scales would invent a crossing that is not real.
- **A third unit is a second chart.** There are two sides and no more, so on a fixed
  chart a quantity in a third unit gets a chart of its own rather than a scale squeezed
  in beside the other two. Only a chart the reader composes gives up its axes instead.
- **A chart the reader composes trades axes for series.** The drive and charge
  telemetry charts let the reader pick any subset of their series (seven on a drive,
  elevation included), so the two-sides rule is applied by count rather than by unit:
  one series on → the left axis, in the series' own color (`coloredAxes`); two → left
  and right, each colored, whatever their units; more than two → no axes at all, every
  series stretched over its own hidden full-height scale (`ownScale`) with the figures
  kept in the tooltip and identity carried by the colored chips. Colored axes exist only
  here — on the fixed charts the pairing is named in the card title; on a composed chart
  nothing else says which scale is whose. Own-scale is all-or-none across a chart: one
  full-height series next to axis-bound ones would read as the biggest quantity on the
  panel, whatever its unit.
- **Axes start where the data starts.** A line series gets its own range plus a tenth of
  its span at each end, rather than recharts' zero-to-the-largest-sample. A battery
  between 48 and 75% otherwise lives in the top third with its peak against the ceiling.
  The padding never crosses a bound the quantity itself cannot (no negative kWh, no 110%).
- **Bars keep their zero baseline.** Shortening a bar's floor exaggerates the difference
  between two of them, so the padding is for lines only.
- **Both axes carry the same number of ticks**, and the ticks are passed explicitly.
  Ticks are spaced evenly, so an equal count is what puts the right-hand labels on the
  same gridlines as the left-hand ones; left to itself recharts rounds each axis
  separately and they drift apart.
- **An estimated series is drawn as a fit over its samples** (`smooth`), the samples kept
  behind it at a fifth of the line's weight. Capacity is not read off the pack, it is
  fitted from whichever sessions were logged, and joining those estimates directly draws
  measurement error as if the battery were ageing and un-ageing week to week. The fit is
  a locally weighted straight line — a slope rather than an average, so the last months
  are not bent flat, robust so one bad session does not own the line — and a series with
  too few samples to fit keeps the ordinary one. **Only for estimates**: on a logged value
  the zigzag is the car, and smoothing it would invent a calmer drive than the one taken.

### 3.9 Two clocks: alarms while busy, the cron while idle

A Durable Object with an armed alarm stays resident for the whole gap, and
residency is what Durable Objects bill. So the vehicle actor
(`schedule` in [`src/actors/vehicle.ts`](../src/actors/vehicle.ts)) picks a
clock per poll:

- **Under 60 s** (driving, charging, online, waking): arm the actor's alarm,
  and write `cars.next_due_at` one minute past it as a watchdog. That write is
  skipped while the stored value is within 30 s, so a 2.5 s loop does not write
  to the database every tick.
- **60 s or more** (asleep, offline, suspended, backed off): delete the alarm
  and write the exact deadline to `cars.next_due_at`. The object is evicted and
  costs nothing until the cron calls `pollDue`.

The cron reads every car's deadline in one query rather than waking each actor
to ask, and gives itself half a minute of slack so a deadline landing just after
a run does not wait a whole extra minute. `pollDue` declines when a live alarm is
due within the minute, so a healthy fast loop is never polled twice; a lost
alarm is picked up by the watchdog deadline. This is why the asleep cadence is
60 s rather than TeslaMate's 30 s: it is what lets a parked car live entirely on
the cron.

The same concern drives `withDeadline` ([`src/core/deadline.ts`](../src/core/deadline.ts)):
`AbortSignal.timeout()` leaves its timer pending after the response arrives,
and a pending timer keeps an object from hibernating, so every request was
billed its full timeout. All outbound requests (Owner API, token refresh,
Nominatim, Open-Meteo, telemetry export) use an `AbortController` whose timer is
cleared as soon as the request and body settle.

### 3.10 Migrations apply themselves

`bun run generate:migrations` bundles `migrations/*.sql` into
`src/db/migrations.generated.ts` (committed; `bun run test` fails if it is stale).
The worker applies whatever is pending on the first request or cron event an
isolate handles ([`src/db/migrate.ts`](../src/db/migrate.ts)); the Node
runtime reads the directory at boot (`--migrate-only` applies and exits). Both
keep the same `d1_migrations` bookkeeping as `wrangler d1 migrations apply`, so
the three are interchangeable and nothing is applied twice. Each migration runs
as one batch with its bookkeeping row, so a failure leaves nothing recorded.
This is what makes "deploy" the whole of an update.

Before the first public release the schema was built by eighteen migrations,
since merged into the one `0001_init.sql` (same schema, column for column). A
database from then already has `0001_init.sql` recorded and skips it; one that
stopped part-way through that series is refused rather than left missing
columns ([`src/db/mergedMigrations.ts`](../src/db/mergedMigrations.ts)). New
schema changes are new files, numbered on from `0002`.

### 3.11 What polling cannot know

A poller sees readings, never transitions, and EVBook says so instead of
pretending otherwise ([`shared/uncertainty.ts`](../shared/uncertainty.ts),
migration 0006):

- **Times are spans.** Each end of a drive or charge may carry `*_after_at` /
  `*_before_at`: it happened no earlier than one reading and no later than the
  next. `start_date_at`/`end_date_at` stay the best point estimate (sorting,
  timelines). A span exists only where something went unseen: a drive whose
  odometer had already moved at its first sample (its start lies between the
  last reading that showed the car not driving — kept by the state machine as
  `notDrivingAt` — and that sample), a session already under way at its first
  sample, an end found by a probe rather than a sample. The UI collapses spans
  of two minutes or less into one time and shows the rest as "06:55–07:01",
  durations as "38–45 min".
- **Reconstructed events.** When the car could not be read (asleep, offline, a
  lapsed token, the Worker down), the odometer and the state of charge still
  move. A cron sweep ([`src/db/hiddenEvents.ts`](../src/db/hiddenEvents.ts),
  rule in [`src/core/gaps.ts`](../src/core/gaps.ts)) walks consecutive
  readings that no recorded event spans and records an odometer increase
  (≥ 0.5 km) as a drive and a state-of-charge rise (≥ 3 points) as a charge,
  with `reconstructed = 1`, both ends spanning the gap, and no duration,
  samples, energy or consumption. They count in totals for what they do know
  (distance, the session count); consumption divides only by distance whose
  energy is known. The History band leaves them out (their span is the gap,
  not the event). Gaps over 7 days are a hiatus, not an event. The sweep waits
  for the drive-origin sweep (§6.8), which owns the gap right before a drive.
- **Unknown is null.** From the database to the screen: an energy, cost or
  duration nobody measured is null and renders "–"; a cost of exactly 0 renders
  "Free".
- **Costs can be ranges.** `cost_cents` is the bottom and `cost_max_cents` the
  top when an input is bounded: a per-minute tariff over a bounded duration, a
  per-kWh tariff over energy known only from the state of charge
  ([`calculateCostRange`](../src/core/derive/cost.ts)). Geofences hold one
  price today; a time-of-use tariff is one more bounded input.

## 4. Data model

Kept deliberately close to TeslaMate's names and semantics (its schema is a
de-facto public API, and it eases importing). Foreign keys are enforced on both
hosts. The authoritative schema is `migrations/`; this is the shape:

```sql
cars(id, eid UNIQUE, vid UNIQUE, vin UNIQUE NOT NULL, name, model, trim_badging,
     marketing_name, exterior_color, wheel_type, spoiler_type,
     efficiency REAL,               -- kWh/km, derived (§6.4)
     next_due_at INTEGER,           -- the cron's poll deadline (§3.9)
     inserted_at, updated_at)

car_settings(car_id PK→cars, enabled DEFAULT 1, suspend_min DEFAULT 21,
     suspend_after_idle_min DEFAULT 15, req_not_unlocked DEFAULT 0,
     free_supercharging DEFAULT 0, lfp_battery DEFAULT 0,
     usable_when_new_kwh REAL)      -- owner's pick where the VIN is ambiguous

settings(id=1 singleton, unit_of_length CHECK(km|mi), unit_of_temperature CHECK(C|F),
     unit_of_pressure CHECK(bar|psi), preferred_range CHECK(ideal|rated),
     timezone DEFAULT 'UTC', timezone_chosen DEFAULT 0, geocode_language DEFAULT 'en', base_url,
     currency DEFAULT 'EUR' (validated against shared/currency.ts),
     drive_origin_swept_before,     -- cursor of the one-off origin repair
     update_checked_at, update_latest_tag,
     telemetry_level DEFAULT 'off', telemetry_instance_id,
     telemetry_last_version, telemetry_stats_at)

positions(id, car_id NOT NULL →cars CASCADE, drive_id →drives SET NULL,
     date_at NOT NULL, latitude, longitude, speed, power, odometer, elevation,
     ideal_battery_range_km, rated_battery_range_km, est_battery_range_km,
     battery_level, usable_battery_level, outside_temp, inside_temp, fan_status,
     driver_temp_setting, passenger_temp_setting,
     is_climate_on, is_rear_defroster_on, is_front_defroster_on,
     battery_heater, battery_heater_on, battery_heater_no_power,
     tpms_pressure_fl, tpms_pressure_fr, tpms_pressure_rl, tpms_pressure_rr)
  -- idx: (drive_id, date_at); (car_id, date_at); partial on speed > 0

drives(id, car_id NOT NULL, start_date_at NOT NULL, end_date_at,
     distance, duration_min, speed_max, power_max, power_min,
     start_km, end_km, outside_temp_avg, inside_temp_avg,
     start_ideal_range_km, end_ideal_range_km,
     start_rated_range_km, end_rated_range_km,
     start_position_id, end_position_id, start_address_id, end_address_id,
     start_geofence_id, end_geofence_id)          -- address/geofence refs SET NULL

charging_processes(id, car_id NOT NULL, start_date_at NOT NULL, end_date_at,
     charge_energy_added, charge_energy_used, duration_min,
     start_battery_level, end_battery_level,
     start_ideal_range_km, end_ideal_range_km,
     start_rated_range_km, end_rated_range_km,
     outside_temp_avg, cost_cents INTEGER,
     position_id, address_id, geofence_id)        -- refs SET NULL

charges(id, charging_process_id NOT NULL →charging_processes CASCADE,
     date_at NOT NULL, battery_level, usable_battery_level,
     charge_energy_added NOT NULL, charger_power NOT NULL,
     charger_voltage, charger_actual_current, charger_phases,
     charger_pilot_current, conn_charge_cable,
     fast_charger_present, fast_charger_brand, fast_charger_type,
     ideal_battery_range_km NOT NULL, rated_battery_range_km,
     not_enough_power_to_heat, battery_heater, battery_heater_on, battery_heater_no_power,
     outside_temp, battery_temp_min, battery_temp_max)
  -- idx: (charging_process_id, date_at)

states(id, car_id NOT NULL, state CHECK(online|asleep|offline),
     start_date_at NOT NULL, end_date_at,
     CHECK(end_date_at IS NULL OR end_date_at >= start_date_at))
  -- partial unique idx: (car_id) WHERE end_date_at IS NULL   ← one open state per car

updates(id, car_id NOT NULL, start_date_at NOT NULL, end_date_at, version)

addresses(id, osm_id, osm_type, UNIQUE(osm_id, osm_type),
     display_name, name, house_number, road, neighbourhood, city, county, postcode,
     state, state_district, country, latitude, longitude, raw /*json*/,
     poi_category, poi_checked_at, inserted_at, updated_at)

geofences(id, name NOT NULL, latitude NOT NULL, longitude NOT NULL,
     radius NOT NULL CHECK(radius > 0 AND radius < 5000),
     billing_type CHECK(per_kwh|per_minute) DEFAULT 'per_kwh',
     cost_per_unit REAL, session_fee_cents INTEGER, inserted_at, updated_at)

terrain(lat_e4, lon_e4, elevation, fetched_at, PK(lat_e4, lon_e4))  -- elevation cache

documents(id TEXT PK, car_id NOT NULL →cars CASCADE,
     category,                      -- title | inspection | tax | insurance
     name, content_type, size_bytes, blob_key, thumb_key, thumb_type, created_at)

telemetry_queue(id, event_name, severity, attributes /*json*/, created_at, attempts)
survey_responses(survey_id PK, status, answers, created_at, updated_at)

tokens(id=1 singleton, access_enc, refresh_enc, updated_at)  -- AES-GCM, mirror only
```

Deviations from TeslaMate (intentional): epoch-ms timestamps; cost in integer
cents; no `display_priority`, no dead `addresses.geofence_id`, no import tables
(an import's working state lives in its actor), no `private` schema, no
`ascent`/`descent` columns.

## 5. Vehicle state machine

The FSM is a port of TeslaMate's `vehicles/vehicle.ex` in polling mode. The
reducer returns a `Decision` — effects, next state, seconds until the next fetch,
and whether to re-handle the same payload in the new state (TeslaMate's
`:next_event`). The actor executes the effects, persists the result and
schedules the next poll (§3.9). Persisted after every transition:
`{state, lastUsedAt, lastStateChangeAt, lastResponse, onlineProbeStreak}`; the
write buffer, breaker counters, token cache, last error and poll deadline are
separate keys in the same storage.

States: `start`, `asleep`, `offline`, `online`, `driving` (sub-states
available / unavailable / offline), `charging`, `updating`, `suspended`
(reported to the UI as `falling_asleep`).

### Polling intervals

| State | Next poll | Fetch |
|---|---|---|
| `asleep` / `offline` | 60 s steady (after a resume: 1 s doubling to 60 s) | cheap probe `GET /vehicles/{id}`; on "online" apply the §3.2 double-probe rule (second probe after 15 s), then `vehicle_data` |
| `online` (idle) | 15 s | `vehicle_data` |
| `online`, sentry / preconditioning / dog mode | 30 s | `vehicle_data` |
| `online`, any other sleep blocker | 15 s | `vehicle_data` |
| `driving` | 2.5 s | `vehicle_data` |
| `charging` | clamp(round(250 / kW), 5..20) s; 5 s if power ≤ 0/unknown | `vehicle_data` |
| `updating` | 15 s | `vehicle_data` |
| `suspended` | `suspend_min` minutes (default 21) | probe, then `vehicle_data` if online |
| driving, unreachable (fewer than 15 probes) | 5 s | `vehicle_data`, falling back to the probe |
| driving, offline | 60 s | `vehicle_data`, falling back to the probe |
| after transient API error | driving 10 s / charging 15 s / online 20 s / else 60 s | — |
| 429 | `retry-after` header, default 300 s | — |
| `EXCEEDED_LIMIT` (403) | 900 s | — |

A 5-minute "position heartbeat" while online or charging is tracked as a
stored `nextHeartbeatAt` checked inside the poll, since each actor has a single
alarm.

### Transition rules (condensed, from TeslaMate)

- On `vehicle_data` while online, evaluate in order:
  1. `software_update.status == "installing"` → `updating`
  2. `shift_state ∈ {D,N,R}` → open drive (insert first position) → `driving`
  3. `charging_state ∈ {Starting,Charging}` → open charging process (resolve
     address + geofence, snapshot position, insert first charge row) → `charging`
  4. else → try to suspend
- `driving` + shift `P`/`nil` → final position → close drive (§6.1) → re-evaluate.
- `driving` + unreachable: 15 probes at 5 s → driving/offline; ≥ 15 min offline →
  close the drive as timed out. Back online: ideal range gained by more than 5
  (in the API's miles, as TeslaMate compares) after ≥ 5 min → close the drive and
  synthesize a charge session from the two snapshots; ≥ 15 min without a gain →
  close the drive; else resume it.
- `charging` + charging_state leaves {Starting,Charging} → final charge row +
  position → complete charging process (§6.2, §6.3) → re-evaluate same payload.
- `charging`/`driving` + asleep → complete/close → `start`.
- `updating`: `installing` → wait; `available` → cancel update → re-evaluate;
  else → finish update (record version) → re-evaluate.
- Suspend is allowed only when idle ≥ `suspend_after_idle_min` (15) **and** no
  blocker: user present → preconditioning → dog mode → sentry → update
  downloading (<100%) → any door/trunk open → unlocked (only if
  `req_not_unlocked`) → power > 0. The blocker is surfaced to the UI as
  `sleepBlocker`. "Unlocked" is the one blocker that does not reset the idle timer.
- `suspended` + probe "asleep"/"offline" → transition and record a state row.
- Stale payloads (`drive_state.timestamp` older than the last processed) are
  discarded and refetched after 2 s.
- States table: any online↔asleep↔offline transition goes through `start`, which
  closes the open `states` row and opens a new one (the partial unique index
  enforces the invariant).
- Circuit breakers (a simplified `:fuse` port, counters in actor storage):
  generic API errors ≥ 3 in 10 min → pause 5 min; `vehicle_not_found` ≥ 8 in
  20 min → pause 10 min.
- `unauthorized`: drop the cached token and ask the auth actor to force a
  refresh (retry in 5 s if it worked, 5 min if not). The auth actor retries a
  failed refresh every 5 min and, after 5 consecutive `unauthorized` refreshes,
  deletes the tokens; the UI then asks for a new sign-in.
- Disabling a car in settings takes it off both clocks.

### User commands

Two Owner API commands work without the signed command protocol, and the car
card offers both: **wake** (`POST /cars/:id/wake`, the one place EVBook
deliberately wakes the car; it credits the fake-wake streak so the next poll
fetches data) and **send destination** (`POST /cars/:id/navigation`, which
refuses rather than wakes a sleeping car).

### Tesla API client

[`src/core/tesla/ownerapi.ts`](../src/core/tesla/ownerapi.ts), a port of
TeslaMate's `lib/tesla_api`; payload schemas are in
[`payload.ts`](../src/core/tesla/payload.ts).

- `GET /api/1/products` (vehicle discovery), `GET /api/1/vehicles/{id}` (cheap
  probe, never wakes, 10 s timeout), `GET /api/1/vehicles/{id}/vehicle_data?endpoints=charge_state;climate_state;closures_state;drive_state;gui_settings;location_data;vehicle_config;vehicle_state;vehicle_data_combo`
  (wakes; 35 s timeout), plus `wake_up` and `command/navigation_request`.
- The OAuth issuer is derived from the access token's `iss` claim (handles EU
  and China accounts), and the Owner API host from the issuer. Both can be
  overridden: `TESLA_AUTH_ISSUER`, `TESLA_API_HOST`.
- Error mapping as TeslaMate: 401→refresh, 404→not_found, 405→in_service,
  408→asleep (fall back to the probe), 429→retry-after, 403 `EXCEEDED_LIMIT`→900 s,
  504→timeout.
- Token refresh: `POST {issuer}/token` with `grant_type=refresh_token`,
  `client_id=ownerapi`, scope `openid email offline_access`; proactive refresh at
  75% of `expires_in`, retry in 5 min on failure.

## 6. Derived values

1. **Drive close** (`Repo.closeDrive`): one SQL pass over the drive's positions
   (window functions over an unbounded frame): distance = Δodometer, duration =
   Δdate, start/end ranges, temperature averages, max speed/power. Guard: < 2
   positions or distance < 0.01 km → delete the drive row. Then resolve start/end
   geofence and address (Nominatim, best-effort; failures are retried by the
   cron), and fill position elevations (below).
2. **Charge complete**: aggregate the session's `charges` rows; energy added is
   counter-reset safe; `fast_charger_type` is the modal value where power > 0.
3. **`charge_energy_used`** ([`src/core/derive/energy.ts`](../src/core/derive/energy.ts)):
   per-sample integration of `phases ? current × voltage × phases / 1000 : power`
   over time. Phase determination needs > 15 samples and applies TeslaMate's √3
   and rounding corrections; inconclusive → falls back to charger power. Done in
   TS — clearer than SQL.
4. **Car efficiency** (kWh/km): after each completed charge, bucket completed
   charges by `round(energy_added / Δrange, precision)` for precision/threshold
   pairs `[5,8], [4,5], [3,3], [2,2]`, filtered to sessions longer than 10 min that
   ended at ≤ 95%; the most frequent bucket wins if seen ≥ threshold times.
   Recomputed for all cars when `preferred_range` changes.
5. **Cost at completion** ([`src/core/derive/cost.ts`](../src/core/derive/cost.ts)):
   free supercharging + a `Tesla…` fast charger → 0; geofence per-kWh →
   `session_fee + rate × max(energy_added, energy_used)`; per-minute → `session_fee + rate ×
   duration_min`; else null. A manually set cost is never overwritten.
   `POST /geofences/:id/apply-costs` backfills sessions at a geofence whose cost
   is still null.
6. **Consumption** ([`consumption.ts`](../src/core/derive/consumption.ts)): range
   delta × efficiency, reported per 100 km only above a minimum distance, below
   which standby losses swamp the figure.
7. **Elevation**: on drive close, positions without an elevation are looked up
   on Open-Meteo's elevation API in batches, cached per ~11 m cell in `terrain`
   so a coordinate is never asked about twice. Imports skip it.
8. **Drive origin** ([`src/core/driveOrigin.ts`](../src/core/driveOrigin.ts)):
   when a new drive's first sample shows unseen distance (between 0.05 and
   20 km) since the last parked position, that position becomes the drive's
   origin, backdated, with `origin_reconstructed = 1` and its start a span
   (§3.11). "Last parked position" is the newest row strictly before the first
   sample: a car found already driving on wake first gets that same snapshot
   filed as a parked row by the state machine's `start`. The origin is placed
   only if the odometer moved no further than the time since the car was last
   read as not driving can explain (150 km/h); otherwise the car was driven
   while unreachable, and the stretch becomes a reconstructed drive of its own.
   A cron sweep applies the same rule to older drives, inferring the quiet
   reading from the state history where the car woke into the drive;
   migrations 0005 and 0006 run it once more.
9. **Vampire drain** (read-time): range lost across idle gaps between
   consecutive drives that contain no charge.
10. **Battery health** (read-time, `batteryHealth` in
    [`src/db/queries/stats.ts`](../src/db/queries/stats.ts)): capacity =
    energy added / share of the pack filled, measured between real
    battery-level ticks where samples exist, dropping the final percent and
    sessions spent heating the pack; headline figures from a window at each end
    of the record. Degradation "from new" uses the as-new capacity decoded from
    the VIN ([`shared/vin.ts`](../shared/vin.ts)) or the owner's pick in car
    settings.
11. **Journeys** ([`src/core/trips.ts`](../src/core/trips.ts)) group drives into
    trips; the **state timeline** ([`src/core/stateTimeline.ts`](../src/core/stateTimeline.ts))
    merges states, drives, charges and updates into one band. Both are pure TS
    so their rules are tested directly.

## 7. API and pages

All routes are Hono routers in `src/api/`, mounted under `/api/v1`; the
endpoint table is in [api.md](./api.md). In outline: session and login, Tesla
sign-in, cars (list, discovery, per-car settings, summaries, suspend/resume,
wake, navigation), drives and charges (filterable lists, detail, GPX and CSV,
cost editing), geofences, statistics, trips, data health, CSV export of raw
tables, imports, documents, version/update, and telemetry. `/health_check`
answers outside `/api`. On Cloudflare, `run_worker_first` in `wrangler.jsonc`
lists every worker-owned path so that navigations to them (downloads) are not
answered by the SPA fallback.

SPA routes (`app/App.tsx`): `/` (overview), `/drives`, `/drives/:id`,
`/charges`, `/charges/:id`, `/trips`, `/history`, `/stats`, `/health`
(battery health, vampire drain, updates, data health), `/geofences`,
`/geofences/new`, `/geofences/:id`, `/documents`, `/settings`, `/import`. The
setup, sign-in and connect-Tesla screens are chosen from `/api/v1/session`
rather than routed.

## 8. Other subsystems

### 8.1 History import

`POST /api/v1/imports` streams another service's export into the import actor's
storage; the actor then replays it through the same FSM a slice per alarm tick,
with a budget of database calls per tick, so a multi-year history survives
request limits and redeploys and a closed tab does not stop it. Progress,
cancel and resume are under `/imports/current`. Sources are adapters in
`src/core/import/adapters/`. Full detail: [import.md](./import.md).

### 8.2 Glovebox documents

Per-car paperwork (title/logbook, inspection, road tax, insurance) in
[`src/api/documents.ts`](../src/api/documents.ts). The `documents` row is the
catalogue; the bytes go to a `BlobStore` under app-generated keys — the
database by default ([`src/db/blobs.ts`](../src/db/blobs.ts), 1 MiB base64
parts, since D1 caps a row at 2 MB), or the bucket when Settings → Features
says so. Each row records its store, so switching only redirects new uploads.
The R2 bucket exists only where R2 is enabled on the account
(`cloudflare.config.ts`), because Cloudflare asks for a payment method first. The client
re-encodes photos (AVIF/WebP, else JPEG/PNG) and makes a small thumbnail before
uploading, so the server accepts only those types and PDF, up to 15 MB. Uploads
are refused in demo mode.

### 8.3 Update check and Install button

Once a day the cron asks GitHub's tag list whether a newer release exists
([`src/core/update.ts`](../src/core/update.ts)) and stores the answer in
settings — the instance asks, never the browser. `DISABLE_UPDATE_CHECK`,
`UPDATE_CHANNEL` and `GITHUB_API_HOST` control it. With `UPDATE_GITHUB_TOKEN`
set, the Settings page also offers **Install**, which dispatches the deploy
workflow of `UPDATE_REPO` (the release repository by default) for that tag;
GitHub Actions builds and replaces the deployment from outside. See
[updating.md](./updating.md).

### 8.4 Telemetry

Opt-in and off by default (`settings.telemetry_level`: `off`, `minimal`,
`extended`). Events are written to `telemetry_queue` when they happen, checked
against the level at that moment, and exported by the cron to an OTLP collector
(`TELEMETRY_ENDPOINT`) in batches — never from the browser. The only identity
is a random instance UUID. Uncaught server errors are reported from
`app.onError`; client crashes arrive through `/telemetry/error`. See
[telemetry.md](./telemetry.md).

### 8.5 Demo mode

`DEMO=true` runs the app against seeded fixture data: no password, no Tesla
account, summaries read from the database, the cron does nothing, and every
endpoint that would reach a real car or store files answers `demo_mode`.
`bun run demo` seeds and starts it on the Node runtime.

### 8.6 Installable app

The service worker in [`app/sw.js`](../app/sw.js) is written by hand and
emitted, not bundled: a Vite plugin in [`vite.config.ts`](../vite.config.ts)
substitutes the hashed filenames of the build it just produced into the file's
precache list, and keys the cache name off both, so a deploy retires the
previous cache on its own. It is registered only from a production build;
`bun run dev:app` unregisters any worker left on the origin, so Vite's dev
server never competes with a cached shell. `app/public/` holds the manifest and
the icon set; `bun scripts/make-icons.mjs` redraws the icons, and its output is
committed.

## 9. Repository layout

```
evbook/
  cloudflare.config.ts        # DO bindings/exports, D1, R2, assets, cron, vars (cf)
  wrangler.jsonc              # the same Worker for wrangler + the vitest pool; kept in step by test:cf-config
  Dockerfile, docker-compose.yml
  src/
    index.ts                  # Cloudflare entry: exports the DO classes, migrates, hands off to app.ts
    app.ts                    # the Hono app and runScheduled (the cron body)
    api/                      # route handlers, one file per resource
    actors/                   # VehicleActor, AuthActor, ImportActor — host-neutral
    do/                       # Durable Object shells around the actors
    platform/
      ports.ts  env.ts        # the seams: SqlDatabase, ActorStorage, BlobStore, AppEnv
      cloudflare/             # bindings → ports
      node/                   # node:sqlite, actor runtime, blobs, cron, server
    core/
      fsm.ts                  # pure transition function
      tesla/                  # Owner API client, payload schemas, JWT issuer
      derive/                 # energy used, cost, consumption
      geo/                    # geofence match, Nominatim, elevation, POI category
      import/                 # import pipeline and source adapters
      convert.ts crypto.ts deadline.ts driveOrigin.ts stateTimeline.ts
      trips.ts update.ts telemetry.ts
    db/
      repo.ts                 # the writes the logger and the importer share
      repair.ts               # the cron's ten-minute repair passes
      migrate.ts              # boot migrations (+ migrations.generated.ts)
      queries/*.ts            # list/stats/detail SQL
  shared/                     # types and pure helpers both sides import (API types,
                              #   time buckets, VIN decoder, version, telemetry)
  migrations/*.sql            # hand-written schema history
  app/                        # React SPA (vite root): pages/ components/ hooks/ lib/ sw.js
  skills/evbook-deploy/       # agent skill for deploying to Cloudflare
  scripts/                    # migration bundler, CLI import, fake Tesla, icons
  test/                       # shared spec support only — no specs
  e2e/                        # Playwright stories, mock world, harness
  deploy/                     # deployment scripts and configs
  docs/
```

The **pure FSM core** (`core/fsm.ts`, no I/O) is the load-bearing design
choice: it makes TeslaMate's scenario tests portable as fixture-driven unit
tests, and it is what lets the importer replay another service's rows through
the same function (the trick TeslaMate's own importer uses).

## 10. Testing

[testing.md](./testing.md) is the full guide. In short:

- **Specs live next to the module they cover** (`scripts/check-test-layout.mjs`
  enforces it); `test/` holds only shared support (fixtures, seeds, helpers).
- **FSM scenario tests**: recorded/synthetic `vehicle_data` sequences →
  asserted effects and states, ported from TeslaMate's vehicle suite.
- **Derived-value tests** with known-answer data (phase correction, counter
  reset, efficiency bucketing, cost rules, consumption, DST bucketing).
- **Pure and Node runtime specs** under `bun test`: the logic above, plus the
  server assembly, actor runtime, blob store and migrations.
- **Worker integration tests** (`*.workerd.test.ts`) on
  `@cloudflare/vitest-pool-workers` with real D1 and migrations, including the
  Durable Object shells with controlled alarms.
- **Browser stories** (`e2e/`, Playwright) against the Node runtime with a mock
  Tesla, geocoder and terrain server; `scripts/fake-tesla.mjs` serves the same
  role for manual local runs.

## 11. Deploy skill (`skills/evbook-deploy`)

`SKILL.md` (+ `verify.sh`) walks an agent through deploying to the user's own
Cloudflare account, idempotent at every step so a re-run is the upgrade path:
preflight, provision D1, secrets, build and deploy, first run, verify, optional
hardening, and troubleshooting. Its hard rule is that secrets never pass
through the chat: the user runs `bun run setup` in their own terminal, which
generates `ENCRYPTION_KEY`, reads `APP_PASSWORD` without echoing it, and hands
both to `cf deploy` through the environment; and
Tesla tokens are entered only in the app's UI.

## 12. Risks

| Risk | Mitigation |
|---|---|
| Lost alarm (deploy or eviction edge) → logging gap | Every alarm has a watchdog deadline in `cars.next_due_at`, which the minute cron honours (§3.9) |
| Fake-wake guard misses the start of a quick getaway | Drive origin reconstruction from the last parked position (§6.8) |
| Database latency from the actor hurts the 2.5 s drive loop | Position writes are buffered; only session open/close is synchronous |
| Durable Object duration billing | Idle cars live on the cron with no alarm; request timers are cleared on completion (§3.9) |
| Owner API deprecation | The client is isolated in `src/core/tesla/`; a Fleet API source would replace it there |
| CPU/time limits on heavy pages | Aggregation in SQL; drive detail positions are downsampled to ~500 points |
| Encryption key lost | Tesla tokens must be re-entered; history is unaffected |
