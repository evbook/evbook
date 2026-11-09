# Local development

```bash
npm install
cp .dev.vars.example .dev.vars
npm run dev          # builds the SPA and runs it on a local worker on :8787 (cf dev)
```

The worker runs under `cf dev`, the Cloudflare CLI, which reads
`cloudflare.config.ts`; `npx wrangler dev` still works off `wrangler.jsonc` —
[cloudflare-cli.md](./cloudflare-cli.md) explains why both exist.
Migrations apply themselves on the first request, against a local D1 under
`.wrangler/state`. For hot reload, run `npm run dev:worker` (the worker without
rebuilding the SPA) beside `npm run dev:app` (Vite, which proxies `/api` to
:8787).

`.dev.vars.example` sets `DEV_AUTOLOGIN=true`, which skips the password screen
locally. It is honoured only for requests to `localhost` / `127.0.0.1` / `[::1]`,
and the Worker config leaves it empty, so a deployment still asks for
`APP_PASSWORD` even if the flag somehow gets set there.

The same app also runs as a plain Node process against one SQLite file — the
way a VPS runs it ([vps.md](./vps.md)):

```bash
cp .env.example .env    # set APP_PASSWORD and ENCRYPTION_KEY; Node reads .env, not .dev.vars
npm run dev:node        # builds the SPA and the server, listens on :3000
```

## Connecting a car

EVBook talks to the Tesla Owner API with an access and refresh token pair, which
you paste into the **Connect your Tesla account** screen. On a computer the
easiest way to get them is [EVBook Token Helper](https://chromewebstore.google.com/detail/evbook-token-helper/bmlcajjacefiijccjjliojdaekghclld),
a Chrome extension (it also runs in Edge and Brave) that signs in on Tesla's own
page and swaps the sign-in code for tokens in the browser; on a phone, any token
app you trust works. The extension's source is in [`extension/`](../extension/),
and `npm run build:app` packs it as `dist/client/evbook-token-helper.zip`.

## Demo mode

The fastest way to see everything working, with no Tesla account and no
password:

```bash
npm run demo         # seeds two cars with years of history, serves on :8787
```

The seed is a generated world — a 2019 Model 3 that commutes and road-trips,
and a 2022 Model Y on school runs and summer holidays — with seasonal weather,
a fading battery, AC and DC charging, and firmware updates, so every screen
has something real to show. The world lives in
[demo/world.mjs](../demo/world.mjs) and is expanded by the same generator the
test suite uses. The demo runs on the Node runtime (no Cloudflare involved);
the database persists in `data/demo/evbook.sqlite` (rebuild it with
`npm run demo:seed`).

Demo mode is an env var (`DEMO=true`), so a public showcase can be deployed
the same way: live summaries are read from the seeded history, and every
endpoint that would talk to a real car or keep a visitor's data — wake,
navigation, account discovery, sign-in, imports, document uploads — answers
`demo_mode` instead. Local-database features
(places, charge costs, settings) stay fully interactive.

## Developing without a car

[`scripts/fake-tesla.mjs`](../scripts/fake-tesla.mjs) impersonates the Tesla
Owner API, so the whole app — polling loop, drive and charge detection, live
UI — can be exercised locally. Start it alongside the dev server:

```bash
node scripts/fake-tesla.mjs
```

With the `TESLA_API_HOST` / `TESLA_AUTH_ISSUER` / `NOMINATIM_HOST` /
`ELEVATION_HOST` lines from `.dev.vars.example` in place, sign in with any
non-empty token pair. The same server also answers reverse-geocoding and
elevation requests, so a local run never calls out to OpenStreetMap or
Open-Meteo. Change what the fixture car is doing at any time:

```bash
curl -X POST localhost:9099/scenario/driving
```

Scenarios are `parked`, `asleep`, `driving` (advances the odometer and drains
the battery, so drives open and close) and `charging`.

To develop against a full history instead of an empty database, seed one with
the same generated world the test suite uses —
[`e2e/README.md`](../e2e/README.md#using-the-mocks-for-ordinary-development) has
the commands for both runtimes.

Or against your own real history, if you are coming from another logger — in the
app under **Settings → Import history**, or from the command line:

```bash
npm run import -- --input ~/Downloads/<VIN>.zip     # stop the dev server first
```

[import.md](./import.md) covers both paths, the sources, what an export can
and cannot give us, how collisions are resolved, and how to add a vendor.

## Tests

```bash
npm test             # unit, worker and Node runtime integration tests (vitest)
npm run typecheck    # app, worker, Node runtime, e2e and tooling sources
npm run lint         # correctness rules, including the React Compiler ones
npm run e2e          # user stories in a browser, both viewports
```

Lint is [ESLint](../eslint.config.js) and carries no style rules — nothing in it
reformats code or argues about naming. It is there for the React Compiler rules in
`eslint-plugin-react-hooks`, which catch impure renders, refs written during
render and state set inside effects, plus the react-query rule that checks a query
key covers what its query function reads. Those are the mistakes this codebase has
actually made. Note the reach of `react-hooks/purity`: it is intra-procedural, so
it sees `Date.now()` in a component body but not the same call inside a helper a
couple of modules away.

Unit and integration specs sit next to the code they cover —
`src/api/drives.ts` is tested by `src/api/drives.test.ts` — and `npm test`
enforces that before it runs anything. [testing.md](./testing.md) has the
layout rule, how to write a worker spec against the real D1 and Durable
Objects, and the principles the browser stories follow.

`npm run e2e` builds the SPA, seeds local SQLite databases from
[`e2e/mocks/world.mjs`](../e2e/mocks/world.mjs), starts the mock Tesla API and
three Node servers, and walks every user story at 1280×800 and 393×852, capturing
a screenshot per step and a screencast per story next to each story. Nothing
touches the network. See [`e2e/README.md`](../e2e/README.md) for the details
and [`e2e/stories/README.md`](../e2e/stories/README.md) for the catalogue.

## The website

[`site/`](../site/) is evbook.app: hand-written static HTML (the landing page and
the Token Helper's page), no build step. Preview it locally with:

```bash
node scripts/serve-site.mjs      # http://localhost:8790
```

The hero shows the real app. Its screenshots live in `site/media/` and are
refreshed from a running demo — start `npm run demo`, then:

```bash
node scripts/capture-site-media.mjs   # needs cwebp on the PATH
```

which captures the overview in both colour schemes and writes the WebP files
the page references. Redo it whenever the overview changes shape.
