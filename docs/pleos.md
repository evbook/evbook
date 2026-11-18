# Hyundai, Kia and Genesis (beta)

EVBook reads a Hyundai, a Kia or a Genesis through the **Pleos Vehicle Data
API**, the makers' own API for car data (Pleos is Hyundai Motor Group's
software brand), with a personal key the owner issues in **Pleos Playground**.
It only reads: the API has no commands, and none of its reads wakes the car.

Status: **beta**, and **Europe only**: Pleos offers the API in Europe since
August 2026. Built and tested against a fake of the published contract, not
yet against a real car. See *Not yet verified* below.

## Connecting

Pick **Hyundai, Kia & Genesis** on the first-run screen, or under **Settings →
Car accounts → Add a car**. It is one page, `/connect/pleos`.

1. **Issue a key.** Sign in to Pleos Playground, open *Workspace → My Vehicle
   Data API*, choose the make, accept the terms and sign in with the maker's
   account (Hyundai Bluelink, Kia Connect, Genesis Connected Services). Pleos
   shows a **Client ID** and a **Client Secret**
   ([Pleos's guide](https://document.pleos.ai/en/api-reference/vehicle-data-api/getting-started/for-private-users/request-my-vehicle-api-key)).
   Only the car's **primary user** can do this; a key issued from a shared or
   secondary account covers no car.
2. **Paste them with the make.** EVBook asks Pleos for an access token with the
   key and lists the cars on it. Only if both work is anything stored: the
   secret encrypted with `ENCRYPTION_KEY`, the client ID and the secret's last
   four characters in the clear.

Every electric (`EV`) and plug-in hybrid (`PE`) car on the key is logged. A
petrol, hybrid or fuel-cell car on it is named on the page and left out.

Pleos issues **one key per make and owner**, and it covers the cars on the
owner's account **when it was issued**. So:

- Each key is an account of its own under **Settings → Car accounts**, with
  one car or several. A Hyundai and a Kia in one household are two keys.
- A car added to the maker's account later needs a new key: reissue it in
  Pleos Playground and use **Replace key**. The new car is added; the cars
  already logged keep their history.
- A key that is revoked, reissued or expires stops every car on it until a new
  one is pasted. **Remove** forgets the key and switches its cars' logging off;
  their history stays, and connecting the key again switches it back on.

**Use the key for EVBook alone.** Pleos gives a key one live token at a time:
issuing a token cancels the one before. If Home Assistant, evcc, Node-RED or a
second EVBook reads with the same key, each keeps cancelling the other's token
and both fail. EVBook notices (three refusals of a live token within an hour),
says so on the car card, and rests the key for a quarter of an hour instead of
joining in.

The personal key is for **the owner's own cars**. Pleos has a separate business
route, with its own approval and a per-car consent screen, for a service that
reads other people's cars; a hosted EVBook for other people should not use
personal keys.

## What is read

Four reads per car, each kept raw in `provider_snapshots` (provider `pleos`,
endpoint = the read; a repeat of the car's last upload only moves
`checked_at`, and a new upload with the same values is kept as a new row):

| Read | EVBook | Pleos field |
|---|---|---|
| `GET /v1/vehicles/{vin}/batteries` | Battery level | `charge.stateOfCharge` |
| | Plugged in | `charge.plugin` (`connected`, `disconnected`) |
| | Charging, AC or DC, scheduled, V2L | `charge.status`, `charge.charging` |
| | Charge limit | `charge.targetStateOfCharge.standard` (AC) / `.quick` (DC) |
| | Time to full | `charge.remainTime` (minutes, only while charging) |
| `GET …/driving` | Driving or parked | `transmission.parkingPosition`, `ignition.ignitionDetails` `ign3` |
| | Odometer | `odometer` (`km`, `mile`, `meter`, `feet`) |
| `GET …/locations` | Position, heading, speed | `location` (WGS84 only), `speed` (`kph`, `mph`, `mps`) |
| `GET …/powertrains` | Range | `distanceToEmpties[type=EV]` |

Every answer carries `data.timestamp`, when **the car** sent it, which can be
hours before EVBook asked: a parked car uploads little or nothing. That is the
time a reading is judged by, never the time EVBook asked. Pleos sends `null`,
`"invalid"` or `"-"` for a value it does not have; each is unknown, never 0. A
state of charge outside 0-100 (Pleos sometimes says 255), an odometer at its
24-bit ceiling, and an unknown unit or status value are unknown too, and only
that field is lost. A position in another datum (Bessel, CoordShift) is not
plotted.

Not read: charging power, energy added, 12 V battery, battery health, charging
schedules (none of these is in the API), and doors, locks and temperatures
(`/status`, whose fields are not documented well enough yet). The history
endpoints (`…/powertrains/data` and others), which arrive up to a day late, are
not read either.

**Drives** run while P is released and the high-voltage system is on (`ign3`),
by an upload less than 20 minutes old. Ready in P (climate, charging
preparation) and accessory mode are not drives. A car on the older CCS 1.0
platform uploads only at the end of a drive, so its drives show as a jump in
the odometer between two parked reads, not as a route.

**Charging** opens on a status of `charging` (AC), `fastCharging` (DC) or
`wirelessCharging`, or on the `charging` flag, by an upload less than two
hours old. `reservedCharging` (waiting for a timer) and `v2lOperating` /
`v2xOperating` (the car powering something) are plugged in, not charging. The
**energy added is unknown**: Pleos reports no power and no energy counter, and
EVBook does not multiply state of charge by a capacity. The charge's start and
end levels and times are logged.

A car clock more than five minutes ahead of EVBook's is not believed: Kia has
acknowledged a fault that adds a daylight-saving hour on some cars' fleet feed.
Such a reading is shown but never starts or holds open a drive or a charge, and
EVBook does not subtract the hour.

## Pace and failures

Pleos publishes no quota. Polling faster buys nothing on a parked car, so:

| Read | Parked | Driving | Charging |
|---|---|---|---|
| batteries | 10 min | 10 min | 5 min |
| driving | 10 min | 2 min | 10 min |
| locations | 60 min | 2 min | 60 min |
| powertrains | 60 min | 10 min | 10 min |

That is 14 requests an hour parked (336 a day) and 72 an hour driving. When a
drive or a charge starts or ends, every read is made once more within two
minutes. EVBook caps itself at 80 requests a car per rolling hour; a 429 can
only make it wait longer.

| Answer | What EVBook does |
|---|---|
| Token refused (HTTP 403, or 400 with `4011`, `40003`, `40004`) | Asks the key's token holder for the current token once and retries; refused again, the car rests an hour |
| `personal-token` refused (`40404`, a wrong secret) | Stops every car on the key and asks for a new key; never retries it by itself |
| `5006` no permission, `4101` / 410 unregistered car | Stops that car (the key stays); a new key starts it again |
| `4045` no data | Keeps what it knew and asks again in 30 minutes. If nothing ever arrives: connected services on, data sharing agreed in the car, the car's e-Privacy setting off, its software current |
| 429 | Waits for `Retry-After`, at least five minutes, a quarter of an hour untold |
| 5xx, timeout | Tries again later |

The access token (about an hour; no refresh token) is held by one actor per
key, `src/actors/pleosAuth.ts`, on the auth actor's class under the key's
account name. Every car on the key asks it, so two cars never cancel each
other's token, and the token issued while checking the key is the one the cars
first read with.

## Not yet verified

These need an owner with a real car:

- Whether Pleos accepts calls from Cloudflare's egress addresses (Volvo judges
  the market by the caller's address and needed a pass-through host).
- How often each read changes on a parked, a driving and a charging car, and
  whether a CCS 2.0 car really uploads every minute while driving.
- Whether `ign3` with P released is a dependable drive signal, and whether
  `ignition.status` reads `on` while the car charges.
- `charge.charging` disagreeing with `charge.status`, and `reservedCharging`
  on a real timer.
- Whether a Kia's Pleos timestamps carry the extra summer hour.
- The quota, and whether it is per key or per car.
- How long a key lasts before it expires (Pleos's pages do not say).
- Genesis at all: no independent client has reported one.

The plan behind this provider, with its sources, is in the maintainers'
research notes (`tmp/hyundai-kia-genesis-implementation-proposal.md`, not in
the repository).
