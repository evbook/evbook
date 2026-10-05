# HTTP API

The SPA talks to the server through a JSON API under `/api/v1`, and the same
endpoints are the integration surface for scripts. Everything except
`GET /health_check`, `GET /api/v1/session` and `POST /api/v1/auth/login`
requires the session cookie that login issues (in demo mode every request is
treated as signed in). The route handlers live in [`src/api/`](../src/api/).

## Session and accounts

| Endpoint | Purpose |
|---|---|
| `GET /health_check` | `{"ok":true}`, for uptime checks |
| `GET /api/v1/session` | Whether you are signed in, whether setup is needed, and the Tesla account's status |
| `POST /api/v1/auth/login`, `DELETE /api/v1/auth/logout` | App password in, session cookie out |
| `POST /api/v1/auth/tesla`, `DELETE /api/v1/auth/tesla` | Connect a Tesla account (`{access, refresh}` tokens) or disconnect it |

## Cars

| Endpoint | Purpose |
|---|---|
| `GET /api/v1/cars` | Registered vehicles |
| `POST /api/v1/cars/discover` | Ask the Tesla account which cars it has and register new ones |
| `GET /api/v1/summaries` | Live state for every car |
| `GET /api/v1/cars/:id/summary` | Live state for one car |
| `PUT /api/v1/cars/:id/logging/suspend` | Pause polling (412 with a reason if refused) |
| `PUT /api/v1/cars/:id/logging/resume` | Resume polling |
| `POST /api/v1/cars/:id/wake` | Wake the car |
| `POST /api/v1/cars/:id/navigation` | Send a destination (`{destination}`) to the car |
| `GET`/`PUT /api/v1/cars/:id/settings` | Per-car settings (polling on/off, sleep timing, free supercharging, battery) |
| `GET`/`PUT /api/v1/settings` | Global settings (units, time zone, currency, telemetry level, …) |

## History

| Endpoint | Purpose |
|---|---|
| `GET /api/v1/drives` | Filterable, sortable list with totals and slider bounds |
| `GET /api/v1/drives/route` | Combined route for the filtered drives |
| `GET /api/v1/drives/:id`, `/api/v1/drives/:id/gpx` | One drive; its track as GPX |
| `GET /api/v1/charges` | Filterable, sortable list with totals |
| `GET /api/v1/charges/map` | Charging locations for the filtered sessions |
| `GET /api/v1/charges/:id`, `/api/v1/charges/:id/csv` | One session; its samples as CSV |
| `PUT /api/v1/charges/:id/cost` | Set or clear a session's cost |
| `GET /api/v1/trips` | Drives grouped into journeys, with their stops |

## Statistics

| Endpoint | Purpose |
|---|---|
| `GET /api/v1/stats?period=day\|week\|month\|year` | Period rollups |
| `GET /api/v1/stats/{charging,drives,efficiency,places}` | Aggregates over a window |
| `GET /api/v1/stats/{states,charge-level,odometer,timeline}` | Series and logs over a window |
| `GET /api/v1/stats/{battery-health,vampire-drain,updates}` | Per-car condition |
| `GET /api/v1/data-health` | Row counts and sessions that were never closed |
| `GET /api/v1/export/:table.csv` | Raw table export (the tables `data-health` counts) |

## Places

| Endpoint | Purpose |
|---|---|
| `GET`/`POST /api/v1/geofences` | List or create places |
| `PUT`/`DELETE /api/v1/geofences/:id` | Edit or delete one |
| `GET /api/v1/geofences/:id/uncosted` | How many charging sessions there still have no cost |
| `POST /api/v1/geofences/:id/apply-costs` | Price those sessions with the place's tariff |

## Glovebox documents

Files are stored in R2 on Cloudflare and under `BLOBS_DIR` on Node. Uploads are
the raw request body with the metadata in query parameters.

| Endpoint | Purpose |
|---|---|
| `GET /api/v1/documents` | Every document, grouped by car |
| `POST /api/v1/documents?car=&category=&filename=` | Upload one (`category` is `title`, `inspection`, `tax` or `insurance`; images or PDF, up to 15 MB) |
| `GET /api/v1/documents/:id/file` | The file itself |
| `GET`/`POST /api/v1/documents/:id/thumbnail` | Its preview image |
| `DELETE /api/v1/documents/:id` | Delete it |

## Import, updates, telemetry

| Endpoint | Purpose |
|---|---|
| `GET /api/v1/imports/sources` | Which services this build can import from |
| `POST /api/v1/imports` | Upload another service's export; `GET`/`DELETE /api/v1/imports/current` for progress and cancel, `POST /api/v1/imports/current/resume` to carry on ([import.md](./import.md#the-http-api)) |
| `GET /api/v1/version` | Running build, and what the last update check found; `POST /api/v1/version/check` asks now |
| `POST /api/v1/version/update` | Dispatch the deploy workflow for the newer release, when an install token is configured ([updating.md](./updating.md)); `GET /api/v1/version/update/run` follows that run |
| `POST /api/v1/telemetry/error` | A crash the client caught; recorded only at the opted-in level ([telemetry.md](./telemetry.md)) |
| `POST /api/v1/telemetry/feedback` | Free-text feedback from the error toast |
| `GET /api/v1/telemetry/survey` | The survey to offer this instance, or null; `POST` settles it with answers or a dismissal |

In demo mode, endpoints that would reach a real car or Tesla account, imports,
document uploads and installs answer `403` with `demo_mode`.
