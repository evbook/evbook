# Home Assistant integration — proposal

**Status:** proposal, not implemented. Feedback and help are welcome.

Two deliverables:

1. **EVBook side** (this repo): a token-authenticated `ha` API that is cheap to
   poll, and an optional webhook push for events.
2. **HACS integration** (new repo, `evbook/ha-evbook`): a Home Assistant custom
   component that turns that API into devices, entities and events.

The constraint that shapes both is the **Workers Free plan**. Everything below
is costed against it, and every design choice that looks indirect is there to
keep Home Assistant from waking a Durable Object.

---

## 0. Budget

| Resource | Free limit | Today | HA adds (1 car, 60 s poll) |
|---|---|---|---|
| Worker requests | 100k/day | ~1,440 cron + UI | ~1,440 |
| DO requests | 100k/day | polling | **0** from polling; webhook adds none (outbound) |
| DO duration | 13,000 GB-s/day | 2.1k–6.6k (measured before the 0.3.9 idle-timer fix) | < 10 (webhook sends, ≤ 3 s each, a few dozen/day) |
| D1 rows written | 100k/day | ≤ ~7.5k worst day ([architecture.md §3.6](../architecture.md#36-write-volume-budget)) | ≤ ~800 (snapshots, throttled) + ≤ 24 (token `last_used_at`) |
| D1 rows read | 5M/day | low | ~1,440 × cars |

Rejected because they do not fit:

- **Persistent MQTT (TeslaMate's model).** An open outbound socket keeps a DO
  from hibernating: 0.128 GB × 86,400 s ≈ 11k GB-s/day per connection, which
  on top of current use exceeds 13k. (Same reason as streaming, [architecture.md
  §3.2](../architecture.md#32-polling-not-streaming).) MQTT stays a possible VPS-only feature later; the VPS has no such meter.
- **HA polling `/api/v1/summaries`.** That fans out to every VehicleDO
  (`src/api/cars.ts`), so a 30 s poll is 2,880 DO wake-ups per car per day and
  keeps parked cars' objects from being evicted — the opposite of what the
  cron-driven parked polling is designed for.
- **KV for the snapshot.** 1k writes/day free; one car parked-polling once a
  minute alone exceeds it.
- **Cache API for the snapshot.** Free and simple, but a no-op on
  `*.workers.dev`, so forks deploying without a custom domain would silently fan
  out to DOs. D1 works on every host, including the VPS's `node:sqlite`.

---

## Part 1 — EVBook

### 1.1 API tokens

Today every `/api/v1/*` route requires the 30-day session cookie, which Home
Assistant cannot renew.

- Migration `0002_api_tokens.sql`:
  ```sql
  CREATE TABLE api_tokens (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,            -- "Home Assistant"
    token_hash TEXT NOT NULL UNIQUE, -- SHA-256 hex of the secret
    scope TEXT NOT NULL CHECK (scope IN ('ha')),
    created_at INTEGER NOT NULL,
    last_used_at INTEGER
  );
  ```
- Token format `evb_<32 random bytes base64url>`, shown once on creation, never
  stored in plaintext.
- `src/app.ts` middleware: if `Authorization: Bearer evb_…` is present, hash it,
  look it up, and allow **only** `/api/v1/ha/*` for scope `ha`. Every other path
  keeps the cookie check. A token never grants the full API.
- `last_used_at` is written at most once an hour per token (compare in memory
  before writing) — writing it on every poll would be 1,440 D1 writes a day for
  a "last seen" label.
- Routes (cookie-auth, for the Settings UI): `GET/POST /api/v1/tokens`,
  `DELETE /api/v1/tokens/:id`.
- Settings page: an "Integrations → Home Assistant" card — create/revoke a
  token, copy the instance URL, and show webhook status (1.4).

### 1.2 Summary snapshot in D1

Have the VehicleDO publish what HA needs, so reading it never touches the DO.

- Migration adds:
  ```sql
  CREATE TABLE car_snapshots (
    car_id INTEGER PRIMARY KEY REFERENCES cars(id) ON DELETE CASCADE,
    summary_json TEXT NOT NULL,   -- CarSummaryDto
    state TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  ```
- Written from `VehicleDO.tick()` (`src/actors/vehicle.ts`, next to the
  `lastFetchAt` write) and from `pollDue()` for parked cars, via one helper
  `publishSnapshot()`:
  - **State change** (`state` differs from the last published one): write now.
  - **Driving / charging / updating**: at most one write per 30 s — ride on the
    position-buffer flush cadence (≤ 30 s), so it adds one row per flush, not
    per 2.5 s poll.
  - **Otherwise**: write only if the summary actually changed (keep a hash of
    the last published JSON in DO storage; parked cars mostly produce identical
    summaries).
  - Worst day (4 h driving + 2 h charging): ≈ 6 h × 120 = 720 rows + transitions.
- The upsert is one `INSERT … ON CONFLICT(car_id) DO UPDATE`. It runs through
  the existing `SqlDatabase` port, so the Node platform gets it for free.

### 1.3 `GET /api/v1/ha/state`

One request returns every car — the HA integration needs one call per update
interval regardless of how many entities it exposes.

```jsonc
{
  "schemaVersion": 1,
  "instance": { "id": "<telemetry_instance_id or new uuid>", "version": "0.3.x" },
  "units": "si",                // km, °C, bar, kW, kWh — HA converts for display
  "generatedAt": 1790000000000,
  "cars": [
    {
      "id": 1, "vin": "5YJ…", "name": "…", "model": "…", "marketingName": "…",
      "snapshotAt": 1790000000000,
      "summary": { /* CarSummaryDto */ }
    }
  ]
}
```

- One D1 query: `cars LEFT JOIN car_snapshots`. Rows read = number of cars.
- A car with no snapshot yet (fresh install) returns `summary: null` — never a
  fallback to DO RPC.
- Response header `Cache-Control: no-store`; `ETag` from max(`updated_at`) so a
  client that sends `If-None-Match` gets a 304 (saves bytes, not requests).
- Demo mode: answer from `demoSummary()` like the other summary routes.
- Also `GET /api/v1/ha/info` (instance id, version, cars without summaries) for
  the config flow's validation step — cheap and cacheable.

### 1.4 Webhook push (optional, for automations)

Polling gives state; automations ("car arrived home and is not plugged in")
want events without waiting a poll interval.

- Stored in `settings`: `ha_webhook_url`, `ha_webhook_secret`,
  `ha_webhook_last_ok_at`, `ha_webhook_last_error`.
- Registered by the integration, not pasted by the user:
  `PUT /api/v1/ha/webhook { url, secret }` / `DELETE /api/v1/ha/webhook`
  (token-auth, scope `ha`).
- Events, emitted from the VehicleDO where the effect is applied
  (`open_drive`, `close_drive`, `open_charging_process`,
  `complete_charging_process`, `open_update`, `finish_update`, state change,
  and plug/unplug derived from `chargingState`/`connChargeCable` transitions):

  | `type` | payload |
  |---|---|
  | `state_changed` | `from`, `to` |
  | `drive_started` / `drive_ended` | `driveId`; on end: distance, duration, energy, start/end address, geofence names |
  | `charge_started` / `charge_ended` | `chargingProcessId`; on end: kWh added, SoC start/end, cost, location |
  | `plugged_in` / `unplugged` | — |
  | `update_started` / `update_finished` | version |

  Every event also carries `carId`, `at`, and the current `summary`, so the
  integration can update entities without a follow-up poll.
- Body is signed: `X-EVBook-Signature: sha256=<HMAC(secret, body)>`, plus
  `X-EVBook-Timestamp`. HA webhook URLs are bearer-by-obscurity; the signature
  makes a leaked URL useless for spoofing.
- Delivery: sent directly from the DO with `withDeadline(3000, …)`
  (`src/core/deadline.ts`) so a slow or unreachable HA costs at most 3 s of DO
  time. On failure the event goes to a small D1 outbox (same shape as
  `telemetry_queue`) that the cron retries; events older than 1 h are dropped —
  stale "drive started" is worse than none. A dead URL is disabled after 24 h of
  failures, and Settings says so.
- Only fires if a URL is registered. No URL → zero cost.

### 1.5 Docs and tests

- `docs/api.md`: the `ha` endpoints and token scope.
- This file becomes the user-facing guide once built (status "as built").
- Tests (Vitest in workerd, like the rest of `src/api/*.test.ts`):
  - token: create/hash/lookup/revoke, scope cannot reach `/api/v1/drives`,
    `last_used_at` throttling.
  - snapshot: written on transition; throttled while driving; skipped when
    unchanged; `/ha/state` never calls the DO (assert with a spy actor).
  - webhook: signature, deadline honoured, outbox retry and expiry, disabled
    after repeated failure.

### 1.6 Delivery order (PRs)

1. Tokens + middleware + Settings card.
2. `car_snapshots` + `publishSnapshot()` + `/ha/state` + `/ha/info`.
   *This alone is usable with HA's built-in `rest:` integration.*
3. Webhook registration, events, signing, outbox.
4. Docs, including a `rest:` YAML fallback for people who do not use HACS.

After PR 2, check real usage with the GraphQL queries in the usage notes
(DO GB-s must not move; D1 writes should rise by hundreds, not thousands).

---

## Part 2 — HACS integration (`evbook/ha-evbook`)

### 2.1 Repo layout

```
custom_components/evbook/
  __init__.py          # setup/unload, coordinator, webhook registration
  manifest.json        # domain "evbook", iot_class "cloud_push", config_flow: true
  config_flow.py       # URL + token; reauth; options (scan interval)
  coordinator.py       # DataUpdateCoordinator over /api/v1/ha/state
  api.py               # tiny aiohttp client, no extra dependency
  webhook.py           # signature check, event dispatch
  entity.py            # base entity: device per car
  sensor.py
  binary_sensor.py
  device_tracker.py
  diagnostics.py       # redacts VIN, token, coordinates
  strings.json, translations/en.json
hacs.json
tests/                 # pytest-homeassistant-custom-component
.github/workflows/     # hassfest, HACS validation, pytest
```

`iot_class` is `cloud_push` when a webhook is registered, `cloud_polling`
otherwise; the manifest declares `cloud_push`, since that's how it normally runs.

### 2.2 Setup flow

1. User creates a token in EVBook → Settings → Home Assistant.
2. HA: *Add integration → EVBook*, enter URL + token.
3. Config flow calls `/api/v1/ha/info`, uses `instance.id` as the config entry's
   unique id (prevents adding the same instance twice).
4. Options: scan interval, default **60 s**, minimum **30 s**, with the budget
   cost shown in the description ("≈ 1,440 requests/day").
5. A 401 starts the reauth flow instead of failing silently.

### 2.3 Data flow

- **Coordinator** polls `/ha/state` at the scan interval. One request covers all
  cars and all entities.
- **Webhook** (if HA is reachable from the internet): on setup the integration
  registers an HA webhook (`webhook.async_register`), uses
  `cloud.async_create_cloudhook` when Nabu Casa is active (otherwise the
  external URL), generates the secret, and `PUT`s both to `/api/v1/ha/webhook`.
  On unload it `DELETE`s it.
- On a webhook event: verify the HMAC and timestamp (±5 min), then
  `coordinator.async_set_updated_data()` with the embedded summary, and fire an
  HA bus event `evbook_<type>` (e.g. `evbook_drive_ended`) with the payload,
  so it can be used in automations and device triggers.
- With a working webhook, the integration can lengthen the poll interval itself
  (e.g. to 5 min) as a safety net — fewer requests, events stay instant.

### 2.4 Entities (one device per car)

Device: name, model/marketing name, VIN as identifier, firmware as `sw_version`,
`configuration_url` → the car's page in EVBook.

| Platform | Entities |
|---|---|
| `sensor` | state (enum), battery level, usable battery level, charge limit, range (preferred: rated/ideal, plus est.), odometer, speed, power, inside/outside temp, climate setpoint, charger power/voltage/current/phases, energy added, time to full, charge rate, TPMS ×4, firmware version, last data at |
| `binary_sensor` | online/asleep, charging, plugged in, charge port door, locked, sentry, user present, doors (any + each), trunk, windows (any + each), climate on, preconditioning, update available, TPMS warnings, healthy (diagnostic) |
| `device_tracker` | GPS from latitude/longitude/heading; HA zones then work out home/away |
| `update` (later) | read-only firmware entity: installed vs available |

- SI units with correct `device_class`/`state_class`, so HA's unit system does
  conversion and long-term statistics work (`odometer` → `total_increasing`,
  `energy added` → `total`).
- Diagnostic and rarely used entities (TPMS, per-door, charger phases) are
  disabled by default to keep the entity list readable.
- Read-only by design: EVBook does not send commands to the car, so there are no
  `switch`/`button`/`climate` entities. Commands belong to the Tesla Fleet
  integration.

### 2.5 Quality bar

- Target HA's integration quality scale "silver": config flow, reauth,
  unique ids, `has_entity_name`, diagnostics with redaction, translations,
  entity unavailable when `snapshotAt` is stale, tests for config flow and
  coordinator.
- CI: `hassfest`, `hacs/action`, pytest against recorded `/ha/state` fixtures.
- Brand icon: PR to `home-assistant/brands` after first release.
- Versioning: `schemaVersion` in the payload; the integration refuses newer
  major versions with a clear "update the integration" repair issue.

### 2.6 Delivery order

1. Skeleton, config flow, coordinator, sensors + binary sensors + tracker
   (works with EVBook PR 2 alone).
2. Webhook registration, signature verification, bus events, device triggers.
3. Diagnostics, reauth, repairs, translations; submit to the HACS default list.

---

## Open questions

- Repository name and owner for the integration (`evbook/ha-evbook`?).
- Should the instance URL in the Settings card be the `settings.base_url` value,
  and does that need to be required for the webhook at all? (It does not —
  outbound only — but the card should show what to type into HA.)
- Multi-car accounts: verify `/ha/state` and device naming with two cars in the
  demo seed.
- A VPS-only MQTT publisher with TeslaMate-compatible topics, so existing
  TeslaMate HA blueprints work unchanged — worth it later, not in this plan.
