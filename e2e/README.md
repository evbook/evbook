# Local test suite

End-to-end user stories against a complete local stack: the real app on the
Node runtime, the real migrations, a local SQLite database seeded with a
generated world, and a mock Tesla API. Nothing reaches the network — no Tesla
account, no OpenStreetMap, no Nominatim, no Open-Meteo, no GitHub, no
Cloudflare, no deployed anything.

```bash
bun run e2e            # both viewports
bun run e2e:desktop    # 1280×800 only
bun run e2e:mobile     # 393×852 only (iPhone 16 portrait)
bun run e2e:report     # open the HTML report
```

Each story writes its screenshots and screencast into its own folder — see
[`stories/README.md`](stories/README.md) for the catalogue and how to add one, and
[`../docs/testing.md`](../docs/testing.md) for the principles this suite is built on and how
it relates to the unit tests next to the code.

## What a run does

`harness/global-setup.ts`:

1. builds the SPA and the server bundle (`E2E_SKIP_BUILD=1` to skip when only
   specs changed),
2. generates the mock world and seeds **three** fresh SQLite databases through the
   real migrations,
3. starts the mock server (Tesla, Nominatim and elevation) on port 9199,
4. starts three Node servers (`dist/server/main.js`), and
5. connects the mock Tesla account, starting the polling loop on one server only.

| Server | Port | Database | Why it exists |
|---|---|---|---|
| history | 8788 | `.state/app.sqlite` | Polling never started and the cron off, so the seeded world is exactly what every list, chart and screenshot shows |
| sign-in | 8789 | `.state/auth.sqlite` | `DEV_AUTOLOGIN` off and Tesla not connected, so the real sign-in flow can be walked |
| live | 8790 | `.state/live.sqlite` | Polling on, cron on; it writes as it goes, which is the point of the live story |

Ports and credentials are in [`harness/env.ts`](harness/env.ts) (the ports can be
moved with `E2E_MOCK_PORT`, `E2E_APP_PORT`, `E2E_AUTH_PORT` and `E2E_LIVE_PORT`).
The suite passes its own `APP_PASSWORD` and `ENCRYPTION_KEY` in each server's
environment, with the update check disabled, so it never reads your `.dev.vars`
or `.env` and a run means the same thing on every machine.

`E2E_KEEP_RUNNING=1 bun run e2e` leaves the stack up so you can poke at
<http://localhost:8788> by hand; `bun run e2e:stop` shuts it down.

Logs from every child process, the generated `seed.sql`, the world `manifest.json`
and the HTML report all land in `.artifacts/`.

## The mock world

```
mocks/world.mjs      ← edit this: the car, the places, the routes, the schedule
mocks/generate.mjs   expands the schedule into rows, simulating the car in order
mocks/sql.mjs        rows → INSERT statements
mocks/db.mjs         applies the real migrations, then the seed, to a SQLite file
mocks/seed.mjs       CLI: migrate + seed a local database
mocks/server.mjs     mock Tesla Owner API, Nominatim and Open-Meteo elevation
```

`world.mjs` is declarative. Places, routes and a schedule of drives, charges and
software updates; `repeat` for patterns ("weekdays for the last ten weeks"), `on`
for one-offs ("the road trip, nine days ago").

`generate.mjs` walks that schedule in time order and simulates the car:

- the odometer only ever grows,
- state of charge falls on drives (by distance, with penalties for cold weather
  and motorway speed) and rises on charges,
- parked cars lose ~1.3%/day to vampire drain, which is what the idle-loss screen
  measures,
- the pack fades slightly every day, which is what the battery-health trend is,
- DC charging tapers as the pack fills; AC holds its rate.

So a change in `world.mjs` ripples through coherently: add a drive and the
odometer, the battery, the statistics totals and the health trend all follow. All
jitter comes from a seeded PRNG, so the same seed moment always produces the same
rows.

Seed a database by hand:

```bash
bun run e2e:seed                          # migrate + seed e2e/.state/app.sqlite
bun e2e/mocks/seed.mjs --sql-only        # print the SQL instead
```

The history is anchored to the moment you seed, not to a fixed date, so it always
lands inside the app's "last 30 days" style filters.

## Using the mocks for ordinary development

`bun run dev` can use the same world — `scripts/fake-tesla.mjs` is a thin wrapper
around `mocks/server.mjs`, on port 9099. With the `.dev.vars.example` lines in
place (`TESLA_API_HOST`, `TESLA_AUTH_ISSUER`, `NOMINATIM_HOST`, `ELEVATION_HOST`)
the dev worker talks to the mock for vehicle data, reverse geocoding and
elevation; for `bun run dev:node`, put the same lines in `.env`. To develop against a full
history rather than an empty database, seed one and hand it to whichever runtime
you are running:

```bash
# Node runtime: seed a file and point the server at it
bun e2e/mocks/seed.mjs --db data/dev.sqlite --fresh
DATABASE_PATH=data/dev.sqlite bun run dev:node

# wrangler dev: generate the SQL and load it with wrangler
bun e2e/mocks/seed.mjs --sql-only > /tmp/seed.sql
bunx wrangler d1 migrations apply evbook --local
bunx wrangler d1 execute evbook --local --file /tmp/seed.sql --yes
bun run dev
```

## Screenshots and screencasts

`story.shot("name")` writes `screens/<viewport>/NN-name.png`, numbered in the
order the steps run, and attaches it to the HTML report. Videos are recorded for
every story and copied to `video/<viewport>.webm` when it finishes.

Screenshots are **documentation, not visual regression baselines** — nothing
compares them between runs. Dates in them track the seed moment, so they change
day to day; the layout does not.

Two things to know if you write stories with maps or charts:

- Map tiles are stubbed with a flat placeholder image, so runs work offline and
  the maps look the same every time.
- The browser clock is deliberately left alone. Leaflet fades tiles in by
  comparing `new Date()` against the fade's start, so pinning the clock leaves
  every map blank.

## Isolation between stories

The suite runs one Playwright worker, no parallelism, in file order, against one
seeded database per server. Stories that write — pricing a charge, editing
places, changing settings, connecting Tesla — put things back as they found
them, because both viewports run the same story in turn against the same stack.
