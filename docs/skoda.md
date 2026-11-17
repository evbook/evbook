# Škoda (beta)

EVBook reads a Škoda through the **MySkoda Public API**, Škoda's own API for
owners, with a key the owner creates in the MySkoda app. It only reads: the
same API takes charging, climate and heating commands, and EVBook has no code
that could send one.

Status: **beta**. Built and tested against a fake of the published contract,
not yet against a real car. See *Not yet verified* below.

## Connecting

Pick **Škoda** on the first-run screen, or under **Settings → Car accounts →
Add a car**. It is one page, `/connect/skoda`.

1. **Create a key.** In the MySkoda app (version 8.16 or later) open
   *Profile → Smart Home*, or open [go.skoda.eu/api-keys](https://go.skoda.eu/api-keys)
   on the phone. Create a key for the car. Škoda shows it once.
2. **Paste the VIN and the key.** EVBook reads the car once with the key. Only
   if Škoda answers for that same VIN is anything stored: the key encrypted
   with `ENCRYPTION_KEY`, its last four characters in the clear.

Škoda issues one key per car, so each Škoda is an account of its own under
**Settings → Car accounts**. A key lapses (about three months is reported;
EVBook shows the date Škoda sends in `X-API-Key-Expires-At` and warns two weeks
ahead). **Replace key** swaps in a new one; the car and its history stay.
**Remove** forgets the key; the car's history stays.

The API is **for personal use**. Škoda directs commercial users to its Charging
Data API, so a hosted EVBook for other people's cars should not use it.

## What is read

One request, `GET /api/v1/vehicles/{vin}?include=info,status,charging,odometer,parkingPosition,airConditioning`.
Every answer is kept raw in `skoda_snapshots` (a repeat only moves
`checked_at`), so a corrected mapping can be run over history again.

| EVBook | Škoda field |
|---|---|
| Battery level, range | `charging.status.battery.*` |
| Charging power, AC/DC, plug, time to full | `charging.status.*` |
| Charge limit | `charging.settings.targetStateOfChargeInPercent` |
| Odometer | `odometer.mileageInKm` (whole km) |
| Parked or driving | `parkingPosition.state` (`PARKED` / `IN_MOTION`) |
| Position | `parkingPosition.gpsCoordinates`, only while parked |
| Locked, doors, windows, boot, bonnet | `status.overall`, `status.detail` |

No speed, power while driving, heading, temperatures or tyre pressures: the
API has none.

**Drives** run from the first read that says `IN_MOTION` to the first that
says `PARKED`. The start position is where the car was last parked; there is
no route in between. A drive shorter than the parked read interval (30
minutes) can be missed entirely.

**Charging** opens on an explicit `CHARGING` or on power flowing through a
cable not known to be out. `plugConnectionState` decides plugged or not;
`CONNECT_CABLE` and `CONSERVING` are never read as charging by themselves.
The energy added is the reported power integrated over the reads, never state
of charge times a guessed capacity; a gap over 15 minutes or a charge with no
power figure adds nothing rather than a guess.

## The quota

Škoda allows 20 requests an hour per key. EVBook reads every 5 minutes while
the car drives or charges, for three reads after either ends, and every 30
minutes while parked, under its own cap of 18 an hour. Škoda's
`RateLimit-Remaining` and `RateLimit-Reset` can only make it wait longer.

| Answer | What EVBook does |
|---|---|
| 401 key expired, 403 not authorized, 404 not found | Stops the car and asks for a new key; never retries a refused key by itself |
| 429 rate limit | Waits for `Retry-After` / the window |
| 429 vehicle not accepting requests, 504 | The car declined (often a weak 12 V battery): backs off |
| 5xx, timeout | Tries again later |
| An answer for another VIN | Stops: one car's key never fills in another car's history |

## Not yet verified

These need an owner with a real Škoda:

- Whether Škoda accepts calls from Cloudflare's egress addresses (Volvo did not).
- How often the cloud copy changes on a parked and on a charging car.
- Whether `chargePowerInKw` is grid-side or battery-side.
- Whether the quota is per key or per VIN (Škoda's own pages disagree).
- `CONNECT_CABLE` and `CONSERVING` on real cars, and the `CHARGING_ERROR` state
  Škoda's test host already lists.

The plan behind this provider, with its sources, is in the maintainers'
research notes (`tmp/skoda-implementation-proposal.md`, not in the repository).
