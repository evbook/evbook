# Importing history from another service

EVBook can take a history logged elsewhere and replay it into its own database,
from the app or from the command line.

## From the app

**Settings → Import history**, or `/import` directly. It is also reachable before
a Tesla account is connected, since arriving from another logger with an export in
hand is exactly when you have not linked Tesla yet.

Pick the export and the page says what it is — which service, which VIN, which
files — before uploading anything: the adapters are pure, so the browser runs the
same detection the server would. Then it uploads, and the import runs in the
background with a progress bar, the date it has reached, and a running count of
drives and charges. **Closing the tab does not stop it**; reopening the page picks
the progress back up.

A two-year export is a few minutes' work. When it finishes the page links straight
to the drives, and lists anything the adapter had to work around.

### Stopping and carrying on

**Cancel** stops the import but keeps the upload and the cursor, so the page offers
**Resume** — which carries on from the sample it had reached instead of doing the
work again. Whatever it had already written stays in the database; that is the
point. **Discard** throws the upload away and returns the page to the file picker.

An import that fails on its own — a hiccup reaching the database, say — keeps the
upload for the same reason, so it can be resumed rather than restarted.

A kept upload is not kept forever: stopping schedules its own reminder, and after
a week EVBook throws the file away and stops offering to resume. The report — how
far it got, what it found — stays either way, and so does everything it had already
written. The page says when the file will go.

Re-uploading the same export instead is also safe: it replaces the period it
covers rather than duplicating it (below). It just repeats work that resuming
would skip.

## From the command line

```bash
npm run import -- --input ~/Downloads/LRW3F7EB9MC123456.zip
```

```
Export:  LRW3F7EB9MC123456.zip
Source:  Tessie (tessie), confidence 100%, VIN LRW3F7EB9MC123456
Files:   driving_states.csv, charging_states.csv, climate_states.csv, …
Target:  .wrangler/state/v3/d1/miniflare-D1DatabaseObject/da41ff….sqlite

Imported into car 1.
Period:  2024-02-27 .. 2026-06-12
Samples: 914k in 11.5s
Drives:  3.1k (29930 km), 269 discarded as too short
Charges: 438 sessions, 251k samples, 6314.3 kWh added
Rows:    188k positions, 7.5k state changes
```

Both paths run the same code and produce byte-identical rows. The CLI writes to a
local SQLite file (or emits SQL for a deployment); the app writes to whichever
database it is running against, which makes it the simpler way to load a
deployment. Imports are refused in demo mode.

Supported today: **Tessie**. The app lists what this build reads, as does
`npm run import -- --list-sources`; [adding a vendor](#adding-a-vendor) is one
file.

## How it works

An import is not a second implementation of drive and charge detection. The
adapter's only job is to turn vendor rows back into the payload Tesla's own API
would have returned, and those payloads then go through the **same state machine
and the same write layer the live logger uses**:

```
export.zip ─► adapter ─► vehicle_data snapshots ─► core/fsm.ts ─► Repo ─► D1
              (vendor)     (Tesla's own shape)     (unchanged)  (unchanged)
```

So an imported drive is closed by the same rule as a logged one, energy and cost
come from the same derivations, `cars.efficiency` is recalculated the same way,
and nothing in the UI or the API needs to know where a row came from.

Two things stand in for what an export cannot carry:

- **Time is data time.** The reducer's `now` is the sample's own timestamp, so
  the sleep and drive-timeout rules measure the car's clock.
- **Gaps mean sleep.** A vendor only writes rows while it can reach the car, so a
  gap of 15 minutes or more is replayed as the probe result the logger would have
  seen — which is what ends an open drive or charging session and fills in the
  `asleep` stretches of the timeline.

The reducer's polling schedule is honoured too: while suspended it asks to be
called back in 21 minutes, so a sample every ten seconds does not turn into a
position row every ten seconds. Samples that change something the reducer
switches on — shift state, charging state, a software update — are always
dispatched, so no transition is thinned away.

### Why the app version runs in slices

An import of a two-year export is tens of thousands of database calls — far more
than one Worker invocation may make. So the upload is parked in the import actor
([`src/actors/import.ts`](../src/actors/import.ts) — a Durable Object on
Cloudflare, the same class over SQLite-backed storage on Node) and the replay
advances on alarms: each tick spends a fixed budget of calls, records where it
got to, and re-arms.

That works because the replay's state is plain data — the same `FsmData` the live
logger already persists between polls — so stopping and resuming is safe. The
adapter cooperates by tracking a charging session's energy from wherever the
session started, not from wherever reading resumed, and
[`src/do/import.test.ts`](../src/do/import.test.ts) pins it down: the same export
imported in slices and in one pass has to land identical rows and identical
derived totals.

## Where the data goes

| Flag | Target |
|---|---|
| *(default)* | The local `wrangler dev` database under `.wrangler/state` |
| `--persist-to <dir>` | A different Wrangler state directory |
| `--db <file>` | One specific SQLite file — e.g. the Node runtime's `data/evbook.sqlite` |
| `--sql <file>` | A throwaway database, dumped as SQL for a deployment |
| `--dry-run` | Nothing — parses and summarises only |

Stop the dev server before importing into its database; two writers on one
SQLite file is asking for trouble. For a VPS, the app's import page is the
simpler route.

For a deployment, import into a throwaway database and push the SQL:

```bash
npm run import -- --input export.zip --sql import.sql
npx wrangler d1 import evbook --remote --file=import.sql
```

The dump keeps row ids, so it expects a remote database whose logging tables are
still empty (`cars`, `car_settings`, `addresses` and `geofences` are written with
`INSERT OR IGNORE`, so an already-registered car survives).

## Which car

The VIN in the export's file name decides:

- a car with that VIN already exists → the history is added to it;
- no such car → one is created, with the model read out of the VIN, and with
  **polling left off** (there is no Tesla id to poll with). Connect your Tesla
  account and switch the car on in Settings when you want live logging.

Override with `--vin`, or point at an existing row with `--car-id`. `--name` sets
the display name of a car the import creates.

When the export carries no VIN — a renamed download — a database with exactly one
car has only one sensible answer, so that car is used and the report says so. With
several cars, the app asks which one and the CLI tells you to say.

## Collisions: merge where it can, replace where it cannot

An import never duplicates and never asks. For the car it resolved:

- a period the car has **no** history for is **merged** — added alongside
  everything else;
- a period the car **does** have history for is **replaced** — the old rows for
  that period go, the imported ones stay.

So importing January and then February keeps both, importing the same export twice
leaves the database exactly as it was, and re-importing after fixing something in
the adapter supersedes the previous run.

The mechanism is deliberately simple: the highest row id in each table is noted
before the import starts, and only rows at or below that mark are eligible to be
dropped. Anything written during the import — including whatever the live logger
records while it runs — is above the mark and is left alone. The report and the
app both say how many rows were replaced.

## Addresses

Reverse geocoding is off by default, so drives and charges import with no
"from → to" labels. The cron repair pass fills them in slowly afterwards
(eight per run, Nominatim's rate limit), or do it during the import — the switch on
the page, or:

```bash
npm run import -- --input export.zip --geocode
```

Nominatim asks for at most one request per second, and a two-year history has
thousands of drive endpoints — but they are mostly the same few dozen places. So the
caches are checked first and **only a miss waits for the throttle**: a point that
can be answered from a cache returns straight away, and the time spent doing that
counts towards the spacing rather than being added to it. Only genuinely new places
cost a request, and the clock carries between slices so the spacing holds across
the whole import rather than restarting fifty times. `--geocode-radius <m>` (or `?geocodeRadius=` on the API)
changes the distance: raise it to spend fewer requests, lower it if adjacent
addresses matter to you.

On one month of a real export — 216 drives and 30 charging sessions, so 462
endpoints to name — that is **83 lookups and 379 answered from cache**, and the
import reports both.

There are two caches, because they fail in different ways. The effective one is
keyed on **where the car was**, and an app import carries it from slice to slice
in the job's own storage. The second is the `addresses` table itself, searched by
coordinate: weaker, because OSM centres a street or a car park a long way from
where you parked, but it survives restarts and is shared with a later import and
with the cron repair pass.

The cache is the database, not memory, and that is deliberate. An import in the app
runs in slices with a fresh write layer per slice, so an in-memory cache would be
discarded tens of times over one import and the same home address would be looked
up again and again. Going through `addresses` also means a second import — and the
cron repair pass — reuse whatever the first one resolved.

## Other options

```
--since <date> --until <date>   Limit the window (UTC)
--min-interval <s>              Thin samples to one every <s> seconds
--sleep-gap <min>               Gap that counts as sleep (default 15, also the floor)
--source <id>                   Skip auto-detection
--vin <vin> / --car-id <id>     Say which car, when the file name does not
--geocode-radius <m>            Reuse an address within this many metres (default 25)
--geocoder <url>                Use a different Nominatim, e.g. a local one
-q                              No progress line
```

## The HTTP API

The app's own endpoints, if you would rather script it:

| Endpoint | Purpose |
|---|---|
| `GET /api/v1/imports/sources` | Which services this build can read |
| `POST /api/v1/imports` | The export as the request body; query parameters mirror the CLI flags (`filename`, `source`, `vin`, `carId`, `name`, `since`, `until`, `geocode`, `geocodeRadius`) |
| `GET /api/v1/imports/current` | Progress and, when it is finished, the report |
| `DELETE /api/v1/imports/current` | Stop the running import, keeping it resumable (`?discard=true` to throw the upload away) |
| `POST /api/v1/imports/current/resume` | Carry on from where a stopped or failed import got to |

```bash
curl -X POST "$HOST/api/v1/imports?filename=$(basename "$FILE")" \
  -H "content-type: application/zip" --data-binary "@$FILE" -b cookies.txt
```

One import runs at a time; a second upload is refused with 409 while one is going.

## What Tessie's export can and cannot give us

The export is one zip named after the VIN, holding `driving_states.csv`,
`charging_states.csv`, `climate_states.csv`, `vehicle_states.csv`,
`battery_states.csv` and one file per tyre. Each is `Timestamp (UTC)` plus
values, and the header carries the unit the account was set to — mi/km, mph/km/h,
°C/°F, bar/psi are all read and normalised.

| Tesla field | What the import does |
|---|---|
| `charge_energy_added` | Pack energy gained since the session started (`Energy Remaining`). Left unknown where the pack file does not reach, rather than substituting the charger's own reading |
| `drive_state.power` | Pack current × pack voltage, negated — Tessie reports current negative while discharging. A moving car reporting exactly 0 A is treated as missing rather than 0 kW |
| `charger_phases` | Taken as exported; when the column is blank, mains voltage means AC and the phase count follows from power ÷ (current × voltage). This is what splits AC from DC in the UI |
| `battery_level` | Tessie exports only the usable level, so both columns get it |
| `fast_charger_type` | Not exported. Left null, so Supercharger sessions are not recognised as free even with free supercharging switched on — geofence pricing still works |
| `est_battery_range`, elevation, software version | Not exported. No `updates` rows, no elevation |
| tyre pressures | Read, but this export's files were empty |

The importer reports whatever it had to work around, per run:

```
Best-effort notes:
  - unmapped column(s): Charge Rate (mph)
  - unmapped column(s): Lifetime Energy Used (kWh), Min Battery Module Temp (°C), …
  - tpms_pressure_fl.csv: no data rows
  - pack energy (battery_states.csv) only starts 2024-04-11 — charges before that
    show the energy the charger delivered but none from the pack, so the Health
    page begins its capacity series on that date
```

That last one is worth understanding. Only the pack can say how much energy a
charge put into the battery; the charger can only say how much it sent, and on AC
that is more — by around a sixth on a slow single-phase supply. The Health page
derives usable capacity as energy added over state of charge gained, so a
wall-side figure there does not read as a slightly optimistic charge, it reads as
a pack larger than the one the factory fitted. Sessions the pack file does not
cover therefore keep their `charge_energy_used`, which is a wall-side reading and
labelled as one, and contribute no capacity point at all.

## Adding a vendor

An adapter is one file in [`src/core/import/adapters/`](../src/core/import/adapters/)
that implements `ImportSourceAdapter`
([`src/core/import/types.ts`](../src/core/import/types.ts)) — the Tessie one,
[`tessie.ts`](../src/core/import/adapters/tessie.ts), is the worked example — and one
`registerSource` call in [`src/core/import/sources.ts`](../src/core/import/sources.ts):

```ts
export const teslafiSource: ImportSourceAdapter = {
  id: "teslafi",
  label: "TeslaFi",
  describe: "TeslaFi monthly CSV archives",
  async detect(bundle) { /* look at the entry names and a header */ },
  async *snapshots(bundle, options) { /* yield { at, data } in ascending order */ },
  async span(bundle) { /* optional: first and last sample, for the progress bar */ },
};
```

Everything else is already there and vendor-agnostic:

| Module | What it gives an adapter |
|---|---|
| [`csv.ts`](../src/core/import/csv.ts) | Streaming CSV, header lookup by name, unit-aware columns, timestamp parsing |
| [`merge.ts`](../src/core/import/merge.ts) | Joins per-metric files into one timeline, carrying each forward until it goes stale |
| [`zip.ts`](../src/core/import/zip.ts), [`bundle.ts`](../src/core/import/bundle.ts) | Reading an export from a zip, a directory, or memory |
| [`replay.ts`](../src/core/import/replay.ts) | Snapshots → state machine → rows |
| [`registry.ts`](../src/core/import/registry.ts) | `--list-sources` and auto-detection |

Nothing in `src/core/import/` uses a Node API, which is what lets the same adapter
run on the server, in the CLI **and in the browser** — the import page imports
`sources.ts` directly to identify a file before uploading it. Two thin shells sit
on top: [`src/actors/import.ts`](../src/actors/import.ts) with
[`src/api/imports.ts`](../src/api/imports.ts) for the app, and
[`scripts/import/`](../scripts/import/) for the CLI (a `D1Database` over
`node:sqlite`, filesystem bundles, and the SQL dump).

Two things an adapter must respect to work in the app:

- **`since` gates emission, not bookkeeping.** An app import resumes by asking
  for samples after the last one it handled. Anything measured from earlier in the
  export — a charging session's energy, a carried-forward value — has to be
  tracked over every sample and only *emitted* from `since` onwards.
- **`span` is optional but worth it.** Without it the progress bar cannot show a
  percentage.
