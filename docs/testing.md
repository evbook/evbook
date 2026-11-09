# Testing

Three layers, one command each.

| Layer | Runner | Lives | Command |
|---|---|---|---|
| Unit + worker integration | Vitest on `@cloudflare/vitest-pool-workers` — real workerd, real D1, real migrations | **next to the code it covers**, `*.test.ts` | `npm test` |
| Node runtime integration | Vitest on plain Node — the server assembly, actor runtime, migrations (`vitest.node.config.ts`) | `src/platform/node/*.test.ts` | `npm run test:node` (part of `npm test`) |
| User stories in a browser | Playwright against the whole local stack on the Node runtime | `e2e/stories/<category>/<story>/`, `*.spec.ts` | `npm run e2e` |

```bash
npm test              # layout, Worker-config and migration checks, then every Vitest suite
npm run lint          # correctness rules (no style rules); see eslint.config.js
npm run test:layout   # just the layout rule below
npm run test:cf-config # cloudflare.config.ts and wrangler.jsonc agree (docs/cloudflare-cli.md)
npm run typecheck     # app, worker, node runtime, e2e and tooling sources
npm run e2e           # the user stories, both viewports
```

## Where a test goes

**A spec lives in the same directory as the module it covers and is named after
it.** There is no mirror tree.

```
src/api/drives.ts          → src/api/drives.test.ts
src/core/derive/cost.ts    → src/core/derive/cost.test.ts
src/do/vehicle.ts          → src/do/vehicle.test.ts
```

- One module, several suites: if a spec outgrows one file, split it as
  `<module>.<aspect>.test.ts` (`drives.filters.test.ts` next to `drives.test.ts`).
  Everything before the first dot must name a real sibling module.
- `*.test.ts` is Vitest. `*.spec.ts` is reserved for the browser stories, so the
  two suites can never collect each other's files.
- Cover a module where it lives, not where it is called from. Route handlers get
  HTTP specs beside the handler (`src/api/*.test.ts`); pure logic gets direct
  specs beside the function (`src/core/**`).

`test/` holds **shared support only — no specs**:

| File | What it is |
|---|---|
| `apply-migrations.ts` | Vitest `setupFiles`: applies the real D1 migrations |
| `env.d.ts` | types for the bindings the pool injects |
| `fixtures.ts` | Tesla vehicle-data payloads (`parked`, `driving`, `charging`) |
| `http.ts` | `login`, `authed`, `getJson` against the real router |
| `db.ts` | `clearTables`, `clearVehicleDO`, `resetCar` |
| `seed.ts` | drive and charge row builders — what the logger would have written |
| `zipfile.ts` | builds a zip in memory, for the import's zip reader and bundle |
| `tessie-export.ts` | a small Tessie-shaped export, as CSV files or a zip |

A helper moves into `test/` when a **second** spec needs it. Until then it stays
local to the file that uses it, where it is easier to read.

### Enforcement

`npm run test:layout` ([`scripts/check-test-layout.mjs`](../scripts/check-test-layout.mjs))
fails the build when

- a `*.test.ts` has no matching module beside it,
- a spec appears under `test/`, or
- a `*.spec.ts` appears under `src/`, `app/` or `shared/`.

`npm test` runs it before Vitest, so the layout cannot drift. It also runs
`scripts/generate-migrations.mjs --check`, which fails when a file in
`migrations/` was added or changed without regenerating
`src/db/migrations.generated.ts` (the bundle the worker migrates itself from). Vitest itself only
collects `{src,shared,app}/**/*.test.ts` and excludes `e2e/` — a spec in the
wrong place fails the check rather than silently not running. The one
exception to the workers pool is `src/platform/node/`, whose specs use
`node:sqlite` and run under `vitest.node.config.ts` instead.

## Writing a worker spec

The pool runs everything inside workerd against one shared D1 database, which
sets a few rules:

- **Reset what you touch.** Isolated storage is off — it cannot stack
  SQLite-backed Durable Objects — so each suite clears its tables in
  `beforeEach` via `resetCar` / `resetLoggedCar` / `clearTables`.
- **Own your car id.** A Durable Object instance created by one spec file is
  invalidated for the next one, so two files must never share a car. Files are
  never run in parallel (`fileParallelism: false`), so distinct ids are enough.
- **The environment is pinned, not inherited.** `vitest.config.ts` sets
  `APP_PASSWORD`, `ENCRYPTION_KEY` and an empty `DEV_AUTOLOGIN`, so a developer's
  `.dev.vars` can never switch the suite to auto-login, and points
  `NOMINATIM_HOST` and `GITHUB_API_HOST` at non-URLs, so nothing can reach the
  network by accident.
- **Test at the lowest level that proves the behaviour.** The reducer in
  `src/core/fsm.ts` is pure, so state-machine scenarios are plain function calls.
  Derivations are known-answer tests. Anything with routing, validation or SQL in
  it goes through `SELF.fetch` on the real Hono app. The logging runtime is
  exercised through `runInDurableObject` with `fetch` stubbed to impersonate the
  Owner API.
- **Seed rows, don't mock queries.** `test/seed.ts` writes the rows the logger
  would have written, so read paths are tested against real SQL and real
  aggregation.

## End-to-end principles

The e2e suite documents the product as much as it verifies it. See
[`e2e/README.md`](../e2e/README.md) for the mechanics and
[`e2e/stories/README.md`](../e2e/stories/README.md) for the catalogue and how to add
a story. The principles behind them:

1. **Real stack, no network.** The real app on the Node runtime, the real
   migrations, local SQLite seeded from a generated world, one mock server for the Owner
   API, Nominatim and the elevation service, stubbed map tiles. A run works on a plane, needs no Tesla
   account, no Cloudflare account, and touches nothing deployed.
2. **A run means the same thing everywhere.** The suite passes its own
   `APP_PASSWORD` and `ENCRYPTION_KEY` in the servers' environment and never
   reads `.dev.vars` or `.env`; locale and time zone are pinned (`en-GB`,
   `Europe/Berlin`).
3. **Stories, not test cases.** One folder per thing a user is trying to do:
   `story.md` in prose, a spec that walks the same numbered steps, and the
   screenshots and screencast those steps produced. The spec's title is what the
   user achieves, not the code it happens to exercise.
4. **Drive it the way a user does.** `getByRole`, `getByLabel`, `getByText` —
   never CSS internals, and never the JSON API to set something up that the UI
   can do. If a step is awkward to express, that is a finding about the UI.
5. **Data belongs to the world, not the test.** New scenarios go into
   [`e2e/mocks/world.mjs`](../e2e/mocks/world.mjs), which the generator expands into
   coherent history — odometer, state of charge, degradation and costs all follow.
   All jitter comes from a seeded PRNG, and history is anchored to the seed
   moment so it always lands inside the app's date presets.
6. **Screenshots are documentation, not baselines.** Nothing is compared between
   runs; they exist so a story folder explains itself and a reviewer can see what
   changed. Dates in them move day to day, the layout does not.
7. **Every story runs at both sizes** — 1280×800 and 393×852 — because the mobile
   layout is a first-class surface, not a fallback.
8. **Writers clean up.** One Playwright worker, one seeded database, file order: a story that
   changes settings, prices a charge or creates a place puts things back, because
   both viewports walk it in turn.
9. **No retries.** `retries: 0`. A story that only passes sometimes is reporting a
   real defect — in the app, the seed data, or a missing wait — and gets fixed at
   the cause.
10. **Determinism has an edge, and it is documented.** Tiles are stubbed and the
    PRNG is seeded, but the browser clock is deliberately left alone: Leaflet
    fades tiles in by comparing `new Date()` against the fade's start, so pinning
    it leaves every map blank.
