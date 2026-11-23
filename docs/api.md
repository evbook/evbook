# HTTP API

The SPA talks to the server through a JSON API under `/api/v1`, and the same
endpoints are the integration surface for scripts. Everything except
`GET /health_check`, `GET /api/v1/session` and `POST /api/v1/auth/login`
requires the session cookie that login issues (in demo mode every request is
treated as signed in). The route handlers live in [`src/api/`](../src/api/).

A request that changes something (anything but `GET`, `HEAD` and `OPTIONS`)
is refused with `403 {"error":"cross_site_request"}` when the browser marks it
as coming from another origin (`Sec-Fetch-Site` other than `same-origin`), so
a page on a sibling subdomain cannot use the session cookie. Scripts and
`curl` do not send that header and are not affected.

## Session and accounts

| Endpoint | Purpose |
|---|---|
| `GET /health_check` | `{"ok":true}`, for uptime checks |
| `GET /api/v1/session` | Whether you are signed in, whether setup is needed (and then `setup`: which secrets are missing and the runtime), and the Tesla account's status |
| `POST /api/v1/auth/login`, `DELETE /api/v1/auth/logout` | App password in, session cookie out |
| `POST /api/v1/auth/tesla`, `DELETE /api/v1/auth/tesla` | Connect the original Tesla account (`{access, refresh}` tokens) or disconnect it |
| `GET /api/v1/accounts` | Every vehicle account: the original Tesla one (`default`), further Tesla accounts, each Škoda key, each Pleos key, Volvo ID (from the moment its API key is saved; `pending` until the first sign-in) — with sign-in state and car count |
| `POST /api/v1/accounts/tesla` | A Tesla account's tokens (`{access, refresh, label?, account?}`): signs `account` back in when it names an existing one, else connects the original one while it is not signed in, else adds another |
| `DELETE /api/v1/accounts/:name` | Forget an account added beside the original ones: sign a further Tesla account out, or drop a Škoda's or a Pleos key (which also switches its cars' logging off); the cars and their history stay. 400 for `default` and `volvo`, which are disconnected from their own cards |

## Volvo

[volvo.md](./volvo.md) describes the connection; these are its routes.

| Endpoint | Purpose |
|---|---|
| `GET /api/v1/volvo` | The connection (`VolvoStatusDto`) and the redirect URI an own application must register; never the secret or key, only the key's last four |
| `PUT /api/v1/volvo/credentials` | `{mode: "linked", apiKey}` or `{mode: "own", clientId, clientSecret, apiKey, scopes?}`; empty secret or key keeps the stored one; a change of client drops the grant |
| `DELETE /api/v1/volvo/credentials` | Forget everything, revoking the grant first |
| `DELETE /api/v1/volvo/connection` | Revoke the grant at Volvo ID; the credentials stay |
| `POST /api/v1/volvo/vehicles` | List the grant's cars again (after fixing the key, say) and restart their polling: `{outcome, vins}` |
| `GET /api/v1/auth/volvo/start` | Begins the consent: 302 to volvo.evbook.app (linked) or Volvo ID (own), with a state cookie |
| `GET /api/v1/auth/volvo/callback` | Where the consent returns; 303 to `/connect/volvo?outcome=<outcome>` — `connected`, `key_refused`, `no_vehicle`, `denied`, `state_mismatch`, `failed`, `not_configured`, `unavailable` |

## Škoda

[skoda.md](./skoda.md) describes the connection; these are its routes.

| Endpoint | Purpose |
|---|---|
| `GET /api/v1/skoda` | Every connected Škoda (`SkodaCarDto[]`): its account, VIN, the key's last four, when the key lapses, and why it was refused if it was; never the key |
| `POST /api/v1/skoda/cars` | `{vin, apiKey}`: checks the key with one read that must answer for that VIN, then stores it and starts logging. 409 when the car is already connected, 422 for a key Škoda refuses, 503 when Škoda or the car is not answering |
| `PUT /api/v1/skoda/cars/:account/key` | `{apiKey}`: a new key for a car already connected, checked the same way |

## Hyundai, Kia, Genesis (Pleos)

[pleos.md](./pleos.md) describes the connection; these are its routes.

| Endpoint | Purpose |
|---|---|
| `GET /api/v1/pleos` | Every connected Pleos key (`PleosAccountDto[]`): its account, make, client ID, the secret's last four, why it was refused if it was, and its cars; never the secret or a token |
| `POST /api/v1/pleos/keys` | `{brand, clientId, clientSecret}` (`brand`: `hyundai`, `kia`, `genesis`): issues a token with the key and lists its cars, then stores it and starts logging its electric and plug-in cars (`PleosConnectResult`: how many, and the cars left out). 409 when the key is already connected, 422 for a key Pleos refuses or one with no electric car, 503 when Pleos is not answering |
| `PUT /api/v1/pleos/keys/:account` | `{clientId, clientSecret}`: a new key of the same make for an account already connected (reissued, or to take in a car added since), checked the same way |

## Cars

| Endpoint | Purpose |
|---|---|
| `GET /api/v1/cars` | Registered vehicles, each with its `provider` (`tesla`, `volvo`, `skoda`, `pleos`, or `unknown` for one this version cannot read) and `tyreAttention` (see [Tyres](#tyres)) |
| `POST /api/v1/cars/discover` | Ask every Tesla account which cars it has and register new ones |
| `GET /api/v1/summaries` | Live state for every car |
| `GET /api/v1/cars/:id/summary` | Live state for one car |
| `PUT /api/v1/cars/:id/logging/suspend` | Pause polling (412 with a reason if refused) |
| `PUT /api/v1/cars/:id/logging/resume` | Resume polling |
| `POST /api/v1/cars/:id/wake` | Wake the car |
| `POST /api/v1/cars/:id/navigation` | Send a destination (`{destination}`) to the car |
| `GET`/`PUT /api/v1/cars/:id/settings` | Per-car settings (polling on/off, sleep timing, free supercharging, battery) |
| `GET`/`PUT /api/v1/settings` | Global settings (units, time zone, currency, telemetry level, …) |
| `GET`/`PUT /api/v1/mqtt` | The MQTT publisher ([mqtt.md](./mqtt.md)): on/off (off whenever no broker is set), broker, user name, password (write-only; `null` clears it), topic prefix (not starting with `$`), and the connection's status. `available` is false on Cloudflare, where a `PUT` is refused (409) |

## History

| Endpoint | Purpose |
|---|---|
| `GET /api/v1/drives` | Filterable, sortable list with totals and slider bounds |
| `GET /api/v1/drives/route` | Combined route for the filtered drives |
| `GET /api/v1/drives/density` | Each filtered drive's track as an encoded polyline (five decimals), for a density map |
| `GET /api/v1/drives/:id`, `/api/v1/drives/:id/gpx` | One drive; its track as GPX |
| `GET /api/v1/charges` | Filterable, sortable list with totals |
| `GET /api/v1/charges/map` | Charging locations for the filtered sessions |
| `GET /api/v1/charges/:id`, `/api/v1/charges/:id/csv` | One session; its samples as CSV |
| `PUT /api/v1/charges/:id/cost` | Set a session's cost by hand, or clear it (see [Costs](#costs)) |
| `GET /api/v1/trips` | Drives grouped into journeys, with their stops |

## Statistics

| Endpoint | Purpose |
|---|---|
| `GET /api/v1/stats?period=day\|week\|month\|year` | Period rollups |
| `GET /api/v1/stats/{charging,drives,efficiency,places}` | Aggregates over a window |
| `GET /api/v1/stats/{states,charge-level,odometer,timeline}` | Series and logs over a window |
| `GET /api/v1/stats/{battery-health,vampire-drain,updates}` | Per-car condition |
| `GET /api/v1/stats/tyres?carId=&range=7d\|30d\|12m` | Tyre pressures over a range, and each tyre's current state ([Tyres](#tyres)) |
| `GET /api/v1/data-health` | Row counts and sessions that were never closed |
| `GET /api/v1/export/:table.csv` | Raw table export (the tables `data-health` counts) |

### Tyres

`GET /api/v1/stats/tyres?carId=1&range=30d` (`range` defaults to `30d`) returns
a `TyrePressureDto`:

```jsonc
{
  "carId": 1, "range": "30d",
  "from": 1760140800000, "to": 1762732800000, "bucketMs": 86400000,
  "current": {
    "at": 1762730000000,          // newest reading on record; null if none
    "tyres": [                    // fl, fr, rl, rr
      { "corner": "rl", "pressureBar": 2.42, "recommendedBar": 2.9, "status": "low" }
    ]
  },
  "points": [                     // every bucket of the window, in order
    { "at": 1760140800000, "fl": 2.86, "fr": 2.9, "rl": 2.87, "rr": 2.88,
      "recommendedFront": 2.9, "recommendedRear": 2.9 },
    { "at": 1760227200000, "fl": null, "fr": null, "rl": null, "rr": null,
      "recommendedFront": null, "recommendedRear": null }  // nothing read: a gap
  ]
}
```

Pressures are bar, the mean of the readings in each bucket. Buckets are 6 hours
for `7d`, a day for `30d` and a week for `12m`, aligned to the epoch. A bucket
with no reading is returned with nulls — never zeros — so a chart breaks its line
there.

`status` is one of `ok`, `low`, `very-low`, `high`, `fault`, `unknown`, decided
by `shared/tyres.ts` — the same function behind the car card's chips, the
summary's `tyres` field and the car list's `tyreAttention`:

| Status | When |
|---|---|
| `very-low` | Tesla's hard TPMS warning, or under 75 % of the axle's recommended pressure |
| `low` | Tesla's soft TPMS warning, or under 90 % of the recommended pressure |
| `high` | Over 120 % of the recommended pressure (a warm tyre reads ~10 % up) |
| `fault` | The car reported the other tyres but not this one |
| `unknown` | No reading, or a reading with neither a recommendation nor an explicit "no warning" from the car |
| `ok` | Anything else |

`tyreAttention` on `GET /api/v1/cars` is true when the car's newest reading has
a `low`, `very-low`, `high` or `fault` tyre.

Readings are stored in `tyre_readings` from the snapshots the logger fetches
anyway, so only while the car is awake: at most one row per 15 minutes, plus one
whenever a warning or recommended pressure changes.

## Places

| Endpoint | Purpose |
|---|---|
| `GET`/`POST /api/v1/geofences` | List or create places |
| `GET`/`PUT`/`DELETE /api/v1/geofences/:id` | Read, edit or delete one |

A place (`GeofenceDto`) carries its tariff and charger:

```jsonc
{
  "name": "Home", "latitude": 52.54, "longitude": 13.42, "radius": 120,
  "timezone": null,          // IANA zone for the tariff's days and hours; null: the account's
  "chargerPowerKw": 11,      // caps the energy any hour can take; null: unknown
  "acEfficiency": null,      // battery / grid, 0.5–1; null: 0.88
  "dcEfficiency": null,      // null: 0.95
  "tariff": [                // dated prices, oldest first; [] = sessions here are not priced
    {
      "validFrom": "2025-01-01",           // first local day it applies; in force until the next one
      "billingType": "per_kwh",            // or "per_minute"
      "rate": 0.36,                        // base rate, major units per kWh / minute
      "sessionFeeCents": null,
      "windows": [                         // later windows win where they overlap
        { "label": "Night", "days": [1,2,3,4,5,6,7], "start": "22:00", "end": "06:00", "months": null, "rate": 0.24 }
      ]
    }
  ]
}
```

A window belongs to the day it starts on (ISO weekdays, 1 = Monday): Monday's
22:00–06:00 runs into Tuesday morning, an end at or before the start crosses
midnight, and `00:00`–`00:00` is a whole day. `months` (1–12, of the starting
day) narrows it to part of the year. Times are the place's wall clock, so a
night window is seven hours long the night clocks go forward.

Read-only on the response: `firstChargeAt` / `firstChargeDate` (the place's
first session and its local day), `chargesBeforeTariff` (sessions before the
first price's day, which stay unpriced — set the first `validFrom` to
`firstChargeDate` to price them) and `repricing` (sessions still queued).

`PUT` replaces every field it is sent; leave `tariff` out to keep the tariff as
it is. Saving reprices only what the change touches: a new dated price, the
sessions from its day on; a corrected price, the sessions in its validity; the
zone, efficiency or charger power, every session there; a moved place, the
sessions that changed place. Up to 60 are repriced in the request, newest
first, and the rest by the ten-minute cron (`repricing` on the response).

## Costs

A charging session's cost is `costCents`, the bottom of a range whose top is
`costMaxCents` (null when exact). `costSource` says where it came from:

- `tariff` — the place's price. Per kWh it bills grid energy: what the car
  reported drawing, else the battery energy divided by the place's efficiency
  (marked `estimated`). The energy is placed in time by the samples' power;
  where samples are more than 15 minutes apart, or a session was not seen at
  all, the range is the cheapest and dearest placement the bounds and the power
  cap allow (the place's charger power; the car's onboard charger on AC). Per
  minute it bills the time between the session's ends, each at its rate.
- `manual` — the owner's figure, never recomputed.
- `legacy` — recorded before tariffs and not reproduced by the tariff; kept.

`GET /api/v1/charges/:id` adds `costDetail` (`CostDetailDto`: the dated price
used, billed kWh, efficiency, and the kWh or minutes at each rate),
`costBilledKwh` and `costNote`.

`PUT /api/v1/charges/:id/cost` takes `{ "value": 12.34, "billedKwh": 30.5, "note": "…" }`
(major units; `billedKwh` and `note` optional) to set a manual cost, or
`{ "value": null }` to drop it and let the tariff price the session again.

## Glovebox documents

Files are stored in the database by default. With Settings → Features
(`documentStorage: "bucket"` on `PUT /api/v1/settings`) new uploads go to R2 on
Cloudflare, or under `BLOBS_DIR` on Node; each document remembers where it is. Uploads are
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
