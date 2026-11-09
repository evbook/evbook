# EVBook

**[evbook.app](https://evbook.app)** — the digital book of your EV's life:
drives, charging, battery health, efficiency, costs, locations and history,
logged from your own account and kept in your own hands. Self-hosted with none
of the self-hosting: **one Cloudflare Worker, one SQLite database, one command
to deploy** — and it runs on Cloudflare's free plan for typical use. No
servers, no Docker, no database to back up or upgrade.

EVBook speaks to Tesla vehicles today (through the Tesla Owner API), and is
structured so other EV makes can follow.

- **One-click agentic deployment** — point Claude Code (or any agent) at the
  bundled [deploy skill](./skills/evbook-deploy/SKILL.md) and it provisions,
  migrates, sets secrets and verifies, without ever asking you to paste a
  secret into the chat. By hand it is four commands.
- **Automatic updates** — the app notices new releases on its own, and on
  Cloudflare an **Install** button deploys them for you via GitHub Actions.
  See [docs/updating.md](./docs/updating.md).
- **Free to run** — D1, R2 and Workers free tiers cover a car or two of
  typical driving. A VPS with Docker, or plain Node, works too, if you'd
  rather ([docs/vps.md](./docs/vps.md)).
- **Your data stays yours** — it logs into your own account, and every table
  is a CSV download away.

## What it does

Logs your car **without keeping it awake** — a vehicle state machine with
careful sleep-preservation rules — and turns the log into:

- **Drives** — route maps, speed/power/battery/temperature charts, GPX export,
  filters and presets that follow you across pages.
- **Charges** — energy, cost, AC/DC split, charging curves, per-session cost
  editing and geofence-based cost rules.
- **Trips** — the drives of one journey put back together: route, stops,
  charges on the way, and what the whole thing cost.
- **Statistics** — distance, energy, cost and consumption by day/week/month/year,
  in your own time zone, plus extrapolated annual mileage.
- **Battery health** — usable capacity and degradation trends, consumption by
  outside temperature (the panel that tells winter apart from wear), idle
  ("vampire") loss, firmware history.
- **History** — one band of asleep/awake/driving/charging/updating over any
  window, and a chronological log for "what happened last Tuesday".
- **Places** — named geofences with a map editor and per-location pricing.
- **Glovebox** — the car's papers (logbook/title, insurance, inspection, road
  tax) kept beside its history, with thumbnails and direct camera capture.
- **Imports your history from another logger** — upload the export in the app
  and watch it replay through the real state machine
  ([docs/import.md](./docs/import.md)).
- **Installs like an app** — a PWA with an offline-aware shell, light and
  dark themes; add it to a phone's home screen and it opens standalone,
  straight into the overview.

## Why EVBook

|  | **EVBook** | TeslaMate | Tessie |
|---|---|---|---|
| Runs on | Your Cloudflare account (or any VPS) | Your server | Their cloud |
| Stack to operate | One Worker + one SQLite database | Elixir + PostgreSQL + Grafana + MQTT broker | — |
| Setup | One command, or one guided agent chat | Docker Compose, reverse proxy, auth setup | Sign-up |
| Running cost | **Free** on Cloudflare's free tier | Server + upkeep | Monthly subscription |
| Maintenance | None — no OS, no database upgrades, no backups to schedule | Image pulls, Postgres major upgrades, backups | None (managed) |
| Updates | Noticed by the app; **one click** installs them | Manual | Managed |
| Your data | Your account; full CSV export | Your server | Their servers |
| UI | One integrated web app + PWA | Grafana dashboards + Phoenix UI | Polished app |
| Keeps the car asleep | Yes | Yes | Yes |

## Deploy your own

The guided path: point Claude Code at
[`skills/evbook-deploy`](./skills/evbook-deploy/SKILL.md) and ask it to
deploy EVBook.

By hand:

```bash
npm install
npx cf auth login
npm run setup      # asks for the password you will log in with, generates the encryption key, deploys
```

That is the whole of it. `npm run setup` generates `ENCRYPTION_KEY` (only if
the worker has none — re-running it never replaces one), asks for
`APP_PASSWORD` without echoing it, and deploys with
[`cf`](https://developers.cloudflare.com/cf/), the Cloudflare CLI. The deploy
provisions the D1 database and the R2 bucket by name in your account (the
config deliberately carries no resource ids), and the worker applies its own
migrations — so the same unmodified configuration deploys into any Cloudflare
account. Later updates are just `npm run deploy`; `npm run setup -- --password`
changes the password. See [docs/cloudflare-cli.md](./docs/cloudflare-cli.md).

Then open the URL, log in, and paste a Tesla access + refresh token pair. The
easiest way to get one on a computer is the
[EVBook Token Helper](https://chromewebstore.google.com/detail/evbook-token-helper/bmlcajjacefiijccjjliojdaekghclld)
browser extension (Chrome, Edge, Brave — source in [`extension/`](./extension/)),
which signs in on Tesla's own page and hands the pair back; any token app you
trust works too. Your cars appear within seconds.

**Keep `ENCRYPTION_KEY` safe.** It encrypts your Tesla tokens at rest; losing
it means signing in to Tesla again. Your logged history is never affected.

Smoke-test a deployment at any time:

```bash
./skills/evbook-deploy/verify.sh https://your-worker.workers.dev
```

Rather run it on your own server? `cp .env.example .env`, set the two secrets,
and `docker compose up -d` — see [docs/vps.md](./docs/vps.md).

No car yet, or just looking? **[demo.evbook.app](https://demo.evbook.app)** is
the whole app against two cars and three years of generated history — no
sign-up, and nothing to install. The same thing runs locally with `npm run
demo` ([docs/development.md](./docs/development.md)).

## Documentation

| | |
|---|---|
| [skills/evbook-deploy](./skills/evbook-deploy/SKILL.md) | The guided Cloudflare deploy, step by step |
| [docs/updating.md](./docs/updating.md) | Updates, the in-app Install button, releases |
| [docs/vps.md](./docs/vps.md) | Running on a VPS with Docker or plain Node |
| [docs/import.md](./docs/import.md) | Importing history from another service |
| [docs/api.md](./docs/api.md) | The JSON API |
| [docs/telemetry.md](./docs/telemetry.md) | Opt-in telemetry — off by default, and what it would send |
| [docs/architecture.md](./docs/architecture.md) | The design, and the reasoning behind it |
| [docs/development.md](./docs/development.md) | Local development, demo mode, the fake Tesla API |
| [docs/testing.md](./docs/testing.md) | How the unit, integration and browser-story tests are organised |
| [deploy/](./deploy/vps/README.md) | How the public demo and evbook.app are hosted — an example, not an install path |

Not included (yet): MQTT publishing (and therefore direct Home Assistant
integration — see the [proposal](./docs/proposals/home-assistant.md)), the
Tesla streaming API, and the official Fleet API. The
[JSON API](./docs/api.md) is the integration surface for now.

## Contributing

Issues and pull requests are welcome. Node 22.13 or newer, then:

```bash
npm install
npm run demo       # the whole app against generated data, on :8787
npm test           # unit + integration, on both the Worker and Node runtimes
npm run typecheck && npm run lint
```

[docs/development.md](./docs/development.md) and
[docs/testing.md](./docs/testing.md) cover the rest, including the browser
story suite (`npm run e2e`). EVBook is not affiliated with Tesla, Inc.

## Credits

EVBook exists because two great products came before it and set the bar.
[TeslaMate](https://github.com/teslamate-org/teslamate) proved that a
self-hosted logger can be gentle to the car's battery and thorough with its
history — its state machine, sleep logic and derived-value algorithms,
sharpened by years of community work, are the intellectual foundation this
project reimplements, and its contributors did the hard thinking first.
[Tessie](https://tessie.com) showed how effortless the experience of a Tesla
logger can be. Deep respect and gratitude to both teams and their
communities — go check them out; either might fit you better.

## License

[Apache-2.0](./LICENSE)
