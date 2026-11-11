<div align="center">

<a href="https://evbook.app"><img src="app/public/icon.svg" width="84" height="84" alt="EVBook logo"></a>

# EVBook

**The self-hosted Tesla data logger that needs no server.**

Drives, charging, trips, battery health and costs — logged from your own account and kept in your own hands.<br>
One Cloudflare Worker, one SQLite database, one command to deploy. Free to run.

[**Website**](https://evbook.app) &nbsp;·&nbsp; [**Live demo**](https://demo.evbook.app) &nbsp;·&nbsp; [**Deploy your own**](#deploy-your-own) &nbsp;·&nbsp; [**Documentation**](#documentation)

[![Version](https://img.shields.io/github/package-json/v/evbook/evbook?label=version&color=2563eb)](https://github.com/evbook/evbook/tags)
[![License: Apache-2.0](https://img.shields.io/github/license/evbook/evbook?color=2563eb)](./LICENSE)
[![Live demo](https://img.shields.io/website?url=https%3A%2F%2Fdemo.evbook.app&label=demo&up_message=live)](https://demo.evbook.app)
[![Runs on Cloudflare Workers](https://img.shields.io/badge/runs%20on-Cloudflare%20Workers-f38020?logo=cloudflare&logoColor=white)](#deploy-your-own)
[![Docker image](https://img.shields.io/badge/docker-ghcr.io%2Fevbook%2Fevbook-2496ed?logo=docker&logoColor=white)](./docs/vps.md)

<br>

<a href="https://demo.evbook.app">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/media/overview-dark.webp">
    <img src="docs/media/overview-light.webp" width="920" alt="The EVBook overview page: battery level, range, temperatures and the car's position on a map">
  </picture>
</a>

</div>

<br>

EVBook is an open-source EV logbook: it records what your car does and turns it
into a history you can read — every drive, every charging session, what it cost
and how the battery is ageing. It speaks to **Tesla** vehicles through the Tesla
Owner API and to **Volvo** through Volvo's official API, and is structured so
other EV makes can follow.

It is self-hosted with none of the self-hosting. Where
[TeslaMate](https://github.com/teslamate-org/teslamate) asks for a server,
PostgreSQL, Grafana and an MQTT broker, EVBook is a single Cloudflare Worker and
a D1 database in your own account — no servers, no Docker, nothing to back up or
upgrade. Prefer your own box? The same app runs as one Docker container.

## Highlights

- **Free to run.** Cloudflare's Workers and D1 free tiers cover a car or two of
  typical driving, and need no payment method on file.
- **One command to deploy.** `bun run setup` provisions, migrates, sets the
  secrets and deploys. Or hand the bundled
  [deploy skill](./skills/evbook-deploy/SKILL.md) to Claude Code (or any coding
  agent) and it does the same, without ever asking you to paste a secret into
  the chat.
- **Lets the car sleep.** A vehicle state machine with careful
  sleep-preservation rules logs the car without keeping it awake, so logging
  does not cost you range.
- **Updates itself.** The app notices new releases on its own, and on Cloudflare
  an **Install** button deploys them for you through GitHub Actions
  ([docs/updating.md](./docs/updating.md)).
- **Your data stays yours.** It signs in to your own account, stores everything
  in your own database, and every table is a CSV download away.

## What it tracks

<table>
  <tr>
    <td width="50%" valign="top">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/media/drive-dark.webp">
        <img src="docs/media/drive-light.webp" alt="A single Tesla drive in EVBook: distance, consumption, battery use and the route on a map">
      </picture>
      <br>
      <b>Drives</b> — route maps, speed, power, battery and temperature charts,
      GPX export, and filters and presets that follow you across pages.
    </td>
    <td width="50%" valign="top">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/media/charge-dark.webp">
        <img src="docs/media/charge-light.webp" alt="A Tesla charging session in EVBook: energy added, cost, charging efficiency and the power curve">
      </picture>
      <br>
      <b>Charges</b> — energy, cost, AC/DC split, charging curves, per-session
      cost editing, and time-of-use tariffs per place: dated prices with
      off-peak windows, charging efficiency, and honest cost ranges where
      the logger could not see when the energy flowed.
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/media/battery-health-dark.webp">
        <img src="docs/media/battery-health-light.webp" alt="Tesla battery health in EVBook: usable capacity, degradation, range at 100% and idle loss over time">
      </picture>
      <br>
      <b>Battery health</b> — usable capacity and degradation trends,
      consumption by outside temperature (the panel that tells winter apart
      from wear), idle ("vampire") loss and firmware history.
    </td>
    <td width="50%" valign="top">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/media/statistics-dark.webp">
        <img src="docs/media/statistics-light.webp" alt="EV statistics in EVBook: distance, energy charged, cost and consumption by month">
      </picture>
      <br>
      <b>Statistics</b> — distance, energy, cost and consumption by day, week,
      month or year, in your own time zone, plus extrapolated annual mileage.
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/media/trips-dark.webp">
        <img src="docs/media/trips-light.webp" alt="Road trips in EVBook: the drives of one journey grouped together with distance, charging stops and cost">
      </picture>
      <br>
      <b>Trips</b> — the drives of one journey put back together: route, stops,
      charges on the way, and what the whole thing cost.
    </td>
    <td width="50%" valign="top">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/media/history-dark.webp">
        <img src="docs/media/history-light.webp" alt="Vehicle history in EVBook: a timeline of asleep, online, driving and charging states with the charge level">
      </picture>
      <br>
      <b>History</b> — one band of asleep, awake, driving, charging and updating
      over any window, and a chronological log for "what happened last Tuesday".
    </td>
  </tr>
</table>

And beside the log itself:

- **Places** — named geofences with a map editor and per-location pricing.
- **Glovebox** — the car's papers (logbook or title, insurance, inspection, road
  tax) kept beside its history, with thumbnails and direct camera capture.
- **Import** — bring your history from another logger: upload the export in the
  app. A Tessie export replays through the real state machine; a TeslaMate
  backup brings its drives, charges, costs and tracks across as they are
  ([docs/import.md](./docs/import.md)).
- **Installs like an app** — a PWA with an offline-aware shell and light and
  dark themes; add it to a phone's home screen and it opens standalone,
  straight into the overview.

Every page is live at **[demo.evbook.app](https://demo.evbook.app)**, against
two cars and three years of generated history — no sign-up, nothing to install.

## EVBook vs TeslaMate vs Tessie

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

### On Cloudflare

You need a Cloudflare account (the free plan is enough), [Bun](https://bun.com)
1.4 or newer, and Node 22.18 or newer — the Cloudflare CLI runs on it.

```bash
git clone https://github.com/evbook/evbook.git && cd evbook
bun install
bunx cf auth login
bun run setup      # asks for the password you will log in with, generates the encryption key, deploys
```

That is the whole of it. `bun run setup` generates `ENCRYPTION_KEY` (only if
the worker has none — re-running it never replaces one), asks for
`APP_PASSWORD` without echoing it, and deploys with
[`cf`](https://developers.cloudflare.com/cf/), the Cloudflare CLI. The deploy
provisions the D1 database by name in your account, and the worker applies its
own migrations — so the same unmodified configuration deploys into any
Cloudflare account. Glovebox documents are kept in D1 unless R2 is enabled on
the account, in which case the deploy provisions a bucket for them. Later
updates are just `bun run deploy`; `bun run setup --password` changes the
password. See [docs/cloudflare-cli.md](./docs/cloudflare-cli.md).

The guided path does the same from a chat: point Claude Code at
[`skills/evbook-deploy`](./skills/evbook-deploy/SKILL.md) and ask it to deploy
EVBook.

### On your own server

```bash
cp .env.example .env    # set APP_PASSWORD and ENCRYPTION_KEY
docker compose up -d    # serves on :3000
```

The compose file runs the published image, `ghcr.io/evbook/evbook` (amd64 and
arm64). Plain Node or Bun without Docker works too —
[docs/vps.md](./docs/vps.md).

### Connect your car

Open the URL, log in, and paste a Tesla access and refresh token pair. The
easiest way to get one on a computer is the
[EVBook Token Helper](https://chromewebstore.google.com/detail/evbook-token-helper/bmlcajjacefiijccjjliojdaekghclld)
browser extension (Chrome, Edge, Brave),
which signs in on Tesla's own page and hands the pair back; any token app you
trust works too. Your cars appear within seconds.

More than one Tesla account? Add the others under **Settings → Tesla accounts**.

Driving a Volvo? Choose **I drive a Volvo** (or **Settings → Volvo**), paste an
API key from a free application on the
[Volvo developer portal](https://developer.volvocars.com/), and sign in with your
Volvo ID. See [docs/volvo.md](./docs/volvo.md) for what is logged and how the
sign-in works.

> [!IMPORTANT]
> **Keep `ENCRYPTION_KEY` safe.** It encrypts your Tesla tokens at rest; losing
> it means signing in to Tesla again. Your logged history is never affected.

Smoke-test a deployment at any time:

```bash
./skills/evbook-deploy/verify.sh https://your-worker.workers.dev
```

## How it works

```
Browser (React SPA) ──► Hono app ──► SQL database (D1 / node:sqlite)
                           │
                           ├─► VehicleActor, one per car: the state machine
                           ├─► AuthActor: Tesla token store and refresh
                           ├─► ImportActor: history import, slice by slice
                           └─► cron, every minute: poll parked cars
```

One actor per car runs a pure state machine — `(state, event) → {next, effects}` —
that decides when to poll, when to back off so the car can fall asleep, and
where a drive or a charge begins and ends. The hosting provider is a layer, not
the architecture: on Cloudflare the actors are Durable Objects and the database
is D1; on a server the same actors run in one process over `node:sqlite`.

Built with TypeScript, [Hono](https://hono.dev), React 19, Tailwind CSS 4,
Recharts and Leaflet. [docs/architecture.md](./docs/architecture.md) has the
design and the reasoning behind it.

## Documentation

| | |
|---|---|
| [skills/evbook-deploy](./skills/evbook-deploy/SKILL.md) | The guided Cloudflare deploy, step by step |
| [docs/updating.md](./docs/updating.md) | Updates, the in-app Install button, releases |
| [docs/vps.md](./docs/vps.md) | Running on a VPS with Docker or plain Node |
| [docs/import.md](./docs/import.md) | Importing history from another service |
| [docs/volvo.md](./docs/volvo.md) | Logging a Volvo: connecting, what is read, the quota |
| [docs/api.md](./docs/api.md) | The JSON API |
| [docs/telemetry.md](./docs/telemetry.md) | Opt-in telemetry — off by default, and what it would send |
| [docs/architecture.md](./docs/architecture.md) | The design, and the reasoning behind it |
| [docs/development.md](./docs/development.md) | Local development, demo mode, the fake Tesla API |
| [docs/testing.md](./docs/testing.md) | How the unit, integration and browser-story tests are organised |

## FAQ

**Is EVBook free?**
Yes. The code is Apache-2.0, and a deployment on Cloudflare's free plan covers a
car or two of typical driving with no payment method on file.

**Which cars does it support?**
Teslas, through the Tesla Owner API, and Volvos, through Volvo's official API
(read-only; Volvo decides which markets it serves — see
[docs/volvo.md](./docs/volvo.md)). Both feed the same state machine, so other EV
makes can follow the same way.

**Will it drain the battery by keeping the car awake?**
No. The polling loop backs off so the car can fall asleep, and the History page
shows how much of the time it actually spent asleep.

**How does it work out what charging cost?**
Give a place a price under Geo-fences: a rate per kWh or per minute, an
optional session fee, and optional time windows with their own rate — a
22:00–06:00 night rate, say, or a winter-only one. Prices are dated: "New price
from…" starts a new one on the day your tariff changed and leaves older
sessions at what they cost then, while correcting a price reprices the sessions
it covers. Where the car did not report what it drew from the grid, the bill is
estimated from the battery's gain at 88% (AC) or 95% (DC) efficiency, or your
own figure per place. A session whose timing is only partly known — a long gap
in the samples, or a charge that happened while the car was offline — gets a
range, from the cheapest to the dearest way it could have fallen across the
rates; the charger's power narrows it. Have the actual bill? Type it in on the
session and it stays. See [docs/api.md](docs/api.md#costs) for the details.

**Can I bring my history from another logger?**
From Tessie and TeslaMate, yes — upload the file under Settings → Import
history. For TeslaMate that is the backup its own docs have you make, as it is
(gzip it first to upload faster):

```bash
docker compose exec -T database pg_dump -U teslamate teslamate > teslamate.bck
```

Only history from before EVBook started logging the car is taken, so nothing is
doubled, and an import can be replaced or deleted as a whole. Other sources are a
matter of writing an adapter; [docs/import.md](./docs/import.md) shows how.

**Does it work with Home Assistant or MQTT?**
Not yet: MQTT publishing (and therefore direct Home Assistant integration — see
the [proposal](./docs/proposals/home-assistant.md)), the Tesla streaming API and
the official Fleet API are not included. The [JSON API](./docs/api.md) is the
integration surface for now.

**Where does my data go?**
Into your own database, and nowhere else to be kept. To do its job the instance
talks to Tesla, to OpenStreetMap and Open-Meteo (to turn coordinates into
addresses and elevation) and to GitHub (the update check). Telemetry to the
project is opt-in and off by default, and
[docs/telemetry.md](./docs/telemetry.md) lists exactly what each level would
send — never the VIN, a location or a credential.

## Contributing

Issues and pull requests are welcome — [CONTRIBUTING.md](./.github/CONTRIBUTING.md)
has the setup and the house rules. The short version:

```bash
bun install
bun run demo       # the whole app against generated data, on :8787
bun run test       # unit + integration, on both the Worker and Node runtimes
bun run typecheck && bun run lint
```

Found a security problem? Please report it privately — see
[SECURITY.md](./.github/SECURITY.md).

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

[Apache-2.0](./LICENSE). EVBook is an independent project and is not affiliated
with Tesla, Inc.
