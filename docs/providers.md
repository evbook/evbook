# Adding a provider

How to add a make to EVBook — a BMW, say — so that it reads like the ones
already there. Written for a person or a coding agent starting from nothing but
this repository and the maker's API documentation.

Škoda is the smallest complete example (one read, one key per car) and Volvo
the fullest (OAuth, fourteen endpoints, three quotas). Read one of them beside
this page: `src/core/skoda/`, `src/actors/skodaPoll.ts`, `src/api/skoda.ts`,
`app/components/SkodaConnect.tsx`, `test/fake-skoda.ts`, `docs/skoda.md`.
Pleos (Hyundai, Kia, Genesis) is the example of one credential covering
several cars whose token they must share: `src/actors/pleosAuth.ts` holds it,
one instance per key, and every car's poller asks it.

## The shape

A provider is **read-only** and **polled**. Its readings are expressed as
Tesla's `vehicle_data` payload and go through the one state machine
(`src/core/fsm.ts`), so its drives and charges are cut by the same rules as a
Tesla's and nothing downstream knows the difference.

```
maker's API ──▶ core/<id>/api.ts ──▶ normalize.ts ──▶ running view ──▶ vehicleData.ts ──▶ fsm.ts ──▶ drives, charges
                      │                                     ▲
                 errors.ts                             pace.ts (when to read next)
```

The vehicle actor (`src/actors/vehicle.ts`) knows no provider. It asks the
car's **poller** for a pass and schedules the next one for when the poller
says. Settings' account list (`src/api/accounts.ts`) knows no provider either:
it asks each provider's **account adapter**. Those two interfaces, and the
shared modules below, are the whole contact surface.

## Before any code

1. **Find the contract.** The maker's published API (OpenAPI, developer
   portal) is the source. Where there is none, public client libraries are
   evidence about the wire protocol: read them, pin the commit, and reimplement.
   Nothing is copied from them, and nothing GPL-licensed is transplanted into
   this Apache-2.0 code base.
2. **Never use real credentials while building.** No sign-in, no token request,
   no authenticated call. The fake (step 7) is what the code is built against.
3. **Answer these in writing** (they become `docs/<id>.md`):
   - What does the owner have to do to connect, and what must EVBook store?
   - Which reads exist, what does each cost against which quota, and what does
     the maker allow per hour or day?
   - How is a drive recognised, and a charge? Which of speed, power, position
     in motion, temperatures, energy added is missing?
   - Does it work from a Cloudflare Worker (plain `fetch` and WebCrypto; no raw
     TCP, no browser, no captcha), and from Cloudflare's addresses? Volvo
     judges the market by caller address and needed a pass-through host.
   - Which commands does the API offer? EVBook sends none of them.
   - What is not verified without a real car? List it; ship as beta.

## The steps

Start by adding the id to `PROVIDERS` in
[`shared/api-types.ts`](../shared/api-types.ts); the `Provider` type follows
from it. **`bun run typecheck` then
fails in four places, and those failures are the to-do list**: every registry
below is a `Record` keyed by the provider, so nothing compiles until the
provider is wired everywhere.

| # | What | Where | Enforced by |
|---|---|---|---|
| 1 | What it can report and do | `CAPABILITIES` in `shared/capabilities.ts` | compiler |
| 2 | The vendor core | `src/core/<id>/` | — |
| 3 | The poller | `src/actors/<id>Poll.ts`, registered in `POLLERS` (`src/actors/pollers.ts`) | compiler |
| 4 | Routes and account adapter | `src/api/<id>.ts`, registered in `ACCOUNT_ADAPTERS` (`src/api/accounts.ts`) and `src/app.ts` | compiler (adapter) |
| 5 | Credentials table, if any | `migrations/NNNN_<id>.sql`, then `bun run generate:migrations` | `bun run test` |
| 6 | The connect screen | `app/lib/makes.ts`, `app/components/<Id>Connect.tsx`, `CONNECTORS` in `app/pages/Connect.tsx` | compiler (connector) |
| 7 | The fake and the specs | `test/fake-<id>.ts`, specs beside each module | `bun run test:layout` |
| 8 | The documentation | `docs/<id>.md`, README, `docs/architecture.md`, `docs/api.md` | — |

### 1. Capabilities

Declare a reading only when the API can actually give it, and
`commands: []`. The car card, Settings and the actor's command refusals all
read this; nothing else asks "is this a BMW?".

### 2. The vendor core: `src/core/<id>/`

Pure and host-neutral: no database, no actor storage, no Cloudflare import.
One module per concern, each with its spec beside it.

| Module | Holds | Rules |
|---|---|---|
| `api.ts` | The client: one function per read, nothing else. `fetch` is injected for the fake. | No function that could send a command. Bound the body size and the time (`core/deadline.ts`). Return `{ ok, value, raw }` or `{ ok: false, error }`; never throw for an HTTP failure. |
| `errors.ts` | `classify(status, body, retryAfter)` → an error *kind*, and the words shown for each kind. | The maker's own message is for logs only: it can carry the VIN. What the owner reads is built from the kind. |
| `normalize.ts` | Wire JSON → a patch of `Reading`s on the provider's view, and `VOLATILE_KEYS`. | **Absent is not zero**: a missing field, an unknown enum value or a wrong type is unknown, never `0`, `""` or `false`. **Coverage is explicit**: a section that answered clears the fields it omits; one that did not answer leaves the previous values standing. |
| `pace.ts` | When to read next, by mode (parked, driving, charging), under the quota. | Keep an own cap below the maker's limit, with room for a connect check and a retry. The maker's rate-limit headers can only make it wait longer. |
| `vehicleData.ts` | The view → `VehicleData` (`src/core/tesla/payload.ts`). | Tesla's units (miles, mph), unrounded so the round trip lands on the maker's figures. What the maker does not report stays `null`. |
| `oauth.ts` | Only where there is a sign-in. | Tokens are stored encrypted (`core/crypto.ts`), refreshed by one actor, never logged. |

Shared code lives in `src/core/provider/` and is **used, not copied**:

- [`session.ts`](../src/core/provider/session.ts) — `nextSession`: charge
  energy integrated from the reported power, for a maker that gives power but
  no energy figure. Never state of charge times a guessed capacity.
- [`snapshot.ts`](../src/core/provider/snapshot.ts) — `fingerprint`: what makes
  two raw answers the same. The provider supplies only `VOLATILE_KEYS`.

A provider's directory imports from `core/provider/`, `core/tesla/payload.ts`
and the general helpers (`core/crypto.ts`, `core/convert.ts`,
`core/deadline.ts`) — **never from another provider's directory**. If a second
provider needs something a first one has, move it to `core/provider/` first.

### 3. The poller: `src/actors/<id>Poll.ts`

Implements `ProviderPoller` ([`providerPoll.ts`](../src/actors/providerPoll.ts)):

- `minDelayMs` — the shortest delay a pass may be scheduled at:
  `CRON_PERIOD_MS`, so the car lives on the cron's clock and never keeps an
  alarm. Only Tesla's poller, whose drive loop is 2.5 s, has zero.
- `pass(car, fsm)` — one polling pass. Reads what is due, keeps every answer raw
  with `storeSnapshot` (one `provider_snapshots` table for every provider: no
  new table), folds it into the view kept in actor storage under the
  provider's own key, and returns either `event` (a `VehicleData` and when to
  read next) or `wait` (how long, and the words for the car card). A vendor
  failure is a `wait`, never an exception. `fsm` and the `probe` result exist
  for a car that sleeps and must not be woken by a read (Tesla); a new
  provider ignores both.
- `restart()` — the owner just acted: forget every pause and refusal.
- `summarize(summary)` — only what this provider adds to the car summary. A
  car whose capabilities have no `sleep` is already shown "online" with no
  sleep blocker.
- No `send`. Only a provider that declares commands implements it, and
  Tesla's wake and send-destination are the only ones EVBook has.

[`teslaPoll.ts`](../src/actors/teslaPoll.ts) is the same interface over the
Owner API, but it is the oldest and least typical poller (no snapshots, no
pacing of its own, commands): read Škoda's or Pleos' as the example.

Then add one line to `POLLERS`. **Do not edit `src/actors/vehicle.ts`**: if a
provider seems to need a branch there, the interface is what should grow.

Rules that have each cost a bug or a quota:

- **A refused credential stops the car** until the owner acts. Nothing retries
  it on a timer: each try spends quota and changes nothing.
- **One car's credentials never fill another car's history.** Where the answer
  names the car, check it against the VIN the pass is for.
- **Never wake a car for data unasked.** Where a wake or refresh call is the
  only way to fresh readings, it is off unless the owner turns it on, and the
  provider's page says what it costs (the 12 V battery, the quota).
- Never schedule under the cron's minute; the actor clamps, the pacing should
  not rely on it.

### 4. Routes and the account adapter: `src/api/<id>.ts`

- Routes under `/api/v1/<id>`, registered in `src/app.ts`. Every one refuses in
  demo mode (`isDemo`). Credentials are checked with one real read **before**
  anything is stored, and stored encrypted with `ENCRYPTION_KEY`; only what
  tells two apart (a last-four, a label) is kept in the clear.
- A car is enrolled by upserting `cars` on its VIN with `provider` and
  `account`, adding its `car_settings` row, and calling
  `env.actors.vehicle(id).restartPolling(id)`.
- An `AccountAdapter` ([`accountAdapter.ts`](../src/api/accountAdapter.ts)):
  `list` gives the provider's rows for Settings → Car accounts, `remove`
  forgets one. Removing must leave nothing waking for a car that can no longer
  be read (Škoda's switches the car's logging off and stops its actor).
  Register it in `ACCOUNT_ADAPTERS`. **Do not edit the body of `accounts.ts`.**
  A provider whose account is a pasted key kept in `<id>_keys` (Škoda, Pleos)
  gets both from `keyAccounts` in the same file, rather than writing them again.
- DTOs go in `shared/api-types.ts`, typed as narrowly as the server knows them
  (a union, not `string`).

### 5. Migrations

Only for what the provider must store about its credentials (`skoda_keys`).
`accounts.provider` has no CHECK and `provider_snapshots` is shared, so a
provider needs no schema change to exist. A migration that has shipped in a
release is never edited; a new one is added.

### 6. The app

- One entry in `MAKES` (`app/lib/makes.ts`). **Every word specific to the make
  lives there** (`needs`, `intro`, `addAnother`, `reconnect`), not in a page:
  no `provider === "<id>"` in `app/pages/`. Mark it `beta: true` until it has
  been proven on real cars.
- `app/components/<Id>Connect.tsx`, the whole of `/connect/<id>`, and one line
  in `CONNECTORS`.
- A screen changed, so run `bun run e2e` and commit the refreshed screenshots.

### 7. The fake and the specs

`test/fake-<id>.ts` is the maker's API behind one `fetch`, built from the
published contract: the car is an object the spec edits, the quota and the
error bodies are the real shapes. Specs install it; nothing in the suite
touches the network.

| Spec | Runner | Must show |
|---|---|---|
| `src/core/<id>/*.test.ts` | bun | Classification of every documented error; unknown and absent values stay unknown; a failed section keeps the old readings; pacing never exceeds the cap; the `VehicleData` bridge. |
| `src/actors/<id>Poll.test.ts` | bun | The pure helpers (mode, charge sample). |
| `src/do/vehicle.<id>.workerd.test.ts` | workerd | Through the real actor: one read stores one snapshot; a repeat stores none; a drive and a charge come out as ordinary rows; a refused credential stops the car and `restartPolling` starts it; a wrong car is never stored; the quota holds. |
| `src/api/<id>.workerd.test.ts` | workerd | Connect, refuse a bad credential without storing it, list in `/accounts`, reconnect, remove (and nothing left scheduled). |

### 8. Documentation

`docs/<id>.md`, in the order `docs/skoda.md` uses: connecting; what is read
(a table of EVBook reading ← maker's field); how drives and charges are
recognised and what can be missed; the quota and what each failure does; **not
yet verified**. Then: a paragraph and a row in the README's tables, the
provider's section in `docs/architecture.md` (§3.12, §5.1, §9), and its routes
in `docs/api.md`.

## Done means

```bash
bun run typecheck && bun run lint && bun run format
bun run test          # layout, config, migrations, bun test, workerd
bun run e2e           # the connect screen changed
```

and, checked by reading the diff:

- [ ] `git diff --stat` shows no change to `src/actors/vehicle.ts`, and none to `src/api/accounts.ts` beyond the `ACCOUNT_ADAPTERS` line.
- [ ] No `provider === "<id>"` outside the provider's own files.
- [ ] No import from another provider's directory; nothing from `core/provider/` re-implemented.
- [ ] No new snapshots table; no CHECK on a provider column.
- [ ] No function that sends a command; no call that wakes the car unasked.
- [ ] No maker's message, VIN, token or key in anything the owner reads or in a log line.
- [ ] Every failure kind has words in one table, and the DTOs use its type.
- [ ] `docs/<id>.md` says what is unverified, and the make is `beta`.
