# Volvo

EVBook reads a Volvo through Volvo's official API — Connected Vehicle v2,
Energy v2 and Location v1 — with a Volvo ID sign-in. It only reads: it never
asks for, and has no code that could use, permission to lock, unlock, start,
honk, heat or move the car.

## Connecting

Pick **Volvo** on the first-run screen, or under **Settings → Car accounts →
Add a car** when another car is already connected. Either way it is one page,
`/connect/volvo`, which is also where the connection is looked after later.

1. **An API key.** Sign in at [developer.volvocars.com](https://developer.volvocars.com/account/),
   create an API application, and copy its *VCC API key*. Volvo counts its
   10 000 calls a day per key (per API, see below), so every owner brings
   their own; one key reads any number of the account's cars.
2. **Paste it and press *Continue to Volvo ID*.** That saves the key and sends
   the browser to [volvo.evbook.app](https://volvo.evbook.app), which names the
   EVBook being connected, then to Volvo ID to sign in and consent, and back
   to the page with the result. The car appears within a minute.

Afterwards the account is a row under **Settings → Car accounts**, and *Manage*
on it opens the same page: reconnect, look for a new car on the Volvo ID (*Find
cars*), change the key — which asks Volvo for the cars again by itself —
disconnect, or remove.

### Account linking, and the alternative

Volvo ID only signs people in for a registered application, through a redirect
URI registered with it, and wants the application's client secret on every
token request — the first and every renewal. So that an owner does not have to
register and publish an application of their own, the project holds one at
**volvo.evbook.app**, which:

- sends the browser to Volvo ID with EVBook's client and its own redirect URI,
  carrying this EVBook's callback and PKCE challenge in a signed state;
- hands the one-time code back to this EVBook's callback;
- forwards this EVBook's token requests (`/token`, `/revoke`) to Volvo ID with
  the client secret added.

It stores nothing; tokens pass through it in transit and are not logged. PKCE
runs end to end, so the code is useless without the verifier this EVBook keeps.
Readings never go there. Home Assistant signs in the same way through Nabu
Casa. The relay's code is in the project's hosting repository.

**Your own application** instead — *Use my own Volvo application* on the page —
signs in with your application's client ID and secret, straight to Volvo ID.
Register the redirect URI the page shows (`https://<your EVBook>/api/v1/auth/volvo/callback`),
publish the application with the scopes below, and paste the client ID (it
starts `vid-`), the secret and the key. `VOLVO_LINK_URL=off` makes this the only
option on an instance.

Only Volvo ID's current realm (`auth.volvocars.com/realms/volvocars`) is
supported. Applications with a `dc-` client ID stop working on 31 January 2027
([Volvo's notice](https://developer.volvocars.com/news/volvoid-migration/)) and
are refused with that explanation.

### Scopes

`openid conve:vehicle_relation conve:engine_status conve:odometer_status
conve:trip_statistics conve:diagnostics_workshop conve:brake_status
conve:diagnostics_engine_status conve:tyre_status conve:warnings
conve:doors_status conve:lock_status conve:windows_status energy:state:read
energy:capability:read location:read` — read-only. Volvo ID refuses the whole
sign-in for a scope the application was not published with, so an own
application without, say, `location:read` sets its own list on the page.
`offline_access` is never added by EVBook.

### Where the calls come from

**Volvo decides which markets it serves by the address an API call comes from.**
A car whose call arrives from outside them is answered
`404 "Does not belong to allowed markets"` on every endpoint, with
`403 "Client not allowed to access Location API"` on Location, and EVBook
stops polling it and says so on the page. Established on 2026-11-12 with a
Cypriot EX30: the same code, client, token (claims `market: "CY"`) and API key
were refused from Cloudflare and read at once from a Cypriot address, as Home
Assistant reads it from home.

A Cloudflare Worker's outgoing address geolocates to the **US** whatever data
centre it runs in (`cdn-cgi/trace` from the car's Durable Object in Paris:
`colo=CDG loc=US`), and Volvo's API does not serve the US. So:

- **On Cloudflare**, EVBook calls Volvo through **volvo-api.evbook.app**, a
  pass-through on the project's server in Germany. It forwards only GET
  requests to the three read APIs, untouched — your token and key go to Volvo
  as they are — and keeps no log, since the paths carry your VIN. Your car's
  readings pass through it in transit and nowhere else. `VOLVO_API_HOST` points
  an instance at a proxy of its own instead (any small reverse proxy in a
  market Volvo serves, forwarding to `https://api.volvocars.com`).
- **On your own server** (Node or Docker), EVBook calls Volvo directly, so the
  server has to be in a market Volvo serves — Europe, by Volvo's list.

Signing in is not affected: Volvo ID issues tokens to any address.

## What is logged

A pass in the car's logger reads whichever endpoints are due, keeps each answer
raw, folds the readings into the car's running state, and hands the same state
machine a Tesla goes through a snapshot in Tesla's shape
([`src/core/volvo/vehicleData.ts`](../src/core/volvo/vehicleData.ts)). So drives
and charging sessions are cut, priced, repaired and summarised by exactly the
rules a Tesla's are.

| EVBook | From Volvo |
|---|---|
| Drive start and end | `engine-status` RUNNING / STOPPED stands in for the gear (there is none in the API) |
| Drive samples | odometer, battery level, range and position, polled every minute while driving; Volvo updates them about every five minutes, and the odometer in whole kilometres |
| Missed short drives | the odometer moving between parked polls, recorded as a reconstructed drive (the existing sweep) |
| Charging session | `chargingStatus` CHARGING; power, AC/DC, target level, time to target, cable |
| Energy added | the reported charging power integrated over the polls — not battery % × capacity, which would make the Health page's capacity estimate measure its own assumption |
| Car card | battery, range, odometer, position, doors, windows, lock, tyre warnings |
| Car name and model | `details` (e.g. "Volvo EX30"), only where the owner has not named the car |

Not available from Volvo, and shown as "–": speed and power while driving,
inside and outside temperature, tyre pressures (only a warning per tyre), and
sleep — a Volvo is "online" all the time as far as EVBook can tell. Wake,
sleep and send-destination are not offered for a Volvo.

**Unknown is never zero.** A `null`, a missing key, `UNSPECIFIED`, an Energy v2
value whose `status` is not `OK` (`PROPERTY_NOT_SUPPORTED`, …), an unknown unit
or enum is unknown, and a response that covers a field but has no value for it
clears the old one ([`src/core/volvo/normalize.ts`](../src/core/volvo/normalize.ts)).

### Raw responses

Every answer is kept as it came in `volvo_snapshots` (car, endpoint,
`fetched_at`, `checked_at`, fingerprint, payload). An answer identical to the
last one, timestamps aside, only moves `checked_at`, so a value is known to
have held from `fetched_at` to `checked_at`. This is what lets a fixed mapping
be run again over history that cannot be collected twice.

## Polling and the quota

Volvo has no push and no sleep signal, so everything is polled, and every call
spends quota: **10 000 calls a day per API per application key**, the three APIs
(Connected Vehicle, Energy, Location) metered separately.

| Mode | Every minute | Every 10 minutes | Hourly | Daily |
|---|---|---|---|---|
| Parked | | battery, engine | odometer, position, statistics, doors, windows, tyres | details |
| Driving | battery, engine, odometer, position | | the rest | details |
| Charging | battery | engine | the rest | details |

When a drive or a charge starts or ends, odometer, position and statistics are
read in the same pass, so a drive's end is not an hour stale. A minute is
exactly the cron's period, so a Volvo never keeps a Durable Object alarm armed:
it lives entirely on the minute cron and costs nothing between polls.

A parked car uses about 300 calls a day per API; a long driving and charging day
up to around 1 500 on the busiest. A token bucket per API
([`src/core/volvo/pace.ts`](../src/core/volvo/pace.ts)) holds each car to its
share of 9 000 a day (10 % kept back), with an hour's worth spendable at once; a
call it refuses stays due rather than being dropped.

| Volvo answers | EVBook |
|---|---|
| 403 "Out of call volume quota" | waits out that API only, until the time Volvo gives |
| 401/403 naming the API key | retries three times (a new key is refused at random for its first hour), then pauses the car an hour |
| 401 | renews the token once and retries; if renewal fails the page — and a line across the top of the app — asks you to sign in again |
| 429 | pauses the car for `Retry-After` |
| 404 "allowed markets", or 404 everywhere | stops the car (the log says where the calls left from); *Find cars* or a new consent starts it again |
| 404 or 403 on one endpoint | skips that endpoint for a day |
| 5xx, timeout | tries again at the next due time |

## Tokens

The Volvo connection is one actor per EVBook — the auth actor's class under the
name `volvo`, so it needed no Durable Object class of its own
([`src/actors/volvoAuth.ts`](../src/actors/volvoAuth.ts)). Its calls are
serialized, which is what makes refresh-token rotation safe: two renewals can
never race and lose the token Volvo issued to one of them. It renews two
minutes before the access token expires, keeps a rotated refresh token (and the
old one when Volvo does not rotate), renews an idle grant before Keycloak's
`refresh_expires_in` lapses, and only drops the grant on `invalid_grant`.
Volvo issued 300-second access tokens and 90-day refresh tokens (2026-11-12),
and documents a grant lasting at most three months however often it is
renewed (longer refresh tokens need *Remember me* at the Volvo ID login); the
card warns when the consent is 75 days old. *Disconnect* revokes at Volvo
ID. The API key, client secret and tokens are encrypted with `ENCRYPTION_KEY`;
the API never returns them, only the key's last four characters.

## Configuration

| Variable | Default | What |
|---|---|---|
| `VOLVO_LINK_URL` | `https://volvo.evbook.app` | Account linking; `off` offers only an own application |
| `VOLVO_API_HOST` | `https://volvo-api.evbook.app` on Cloudflare, `https://api.volvocars.com` elsewhere | Where Volvo's API is called — see [where the calls come from](#where-the-calls-come-from) |
| `VOLVO_AUTH_ISSUER` | `https://auth.volvocars.com/realms/volvocars` | Volvo ID, own-application mode |

The API key and (own mode) client credentials are entered on the page, not set
as variables.

## What has been checked against the real API

Against a real EX30 (2024, Cyprus) on 2026-11-11 and 12:

- **Sign-in:** linked sign-in through volvo.evbook.app end to end, renewal
  through the relay, the vehicle list, API keys from two applications; tokens
  of 300 s with 90-day refresh, claims `azp` (the client) and `market`.
- **Where calls come from** decides the market (above), and through
  volvo-api.evbook.app an EVBook on Cloudflare reads the same car: every
  endpoint answered on the first pass.
- **Every endpoint answers** from a served market: Energy v2 state and
  capabilities, details, engine status, odometer, statistics, doors (with
  `tankLid`), windows (with `sunroof`), tyres, Location.
- **Energy v2:** per-property `updatedAt` (the target level weeks older than
  the rest); `chargingCurrentLimit` and `transferLimit` are
  `PROPERTY_NOT_SUPPORTED`; `chargingPower` is `PROPERTY_NOT_FOUND` while idle
  though the capabilities list it; one minute to the target while unplugged.
- **Details:** `fuelType` `ELECTRIC` (the earlier report of `NONE` for an EX30
  is still mapped), `batteryCapacityKWH` 69.0, AWD, 315 kW.
- **Location:** GeoJSON with altitude 0.0 (taken as unknown), heading as a
  string, a top-level `status` and `operationId`.
- **A drive:** engine status `RUNNING` while driving and `STOPPED` after — the
  drive opened and closed on it. The **odometer is whole kilometres**, so a
  drive's distance is too, and Volvo's values change about **every five
  minutes** while driving (odometer and position both): polling every minute
  catches each update within a minute rather than adding samples.

**Still unverified:** charging — the charging statuses and power while a
session runs, and how the integrated power compares with the battery level
gained (AC power may be measured before the charger's losses). Everything is
also covered against a fake Volvo in [`test/fake-volvo.ts`](../test/fake-volvo.ts),
which answers in the shapes above.
