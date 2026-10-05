# Telemetry

Opt-in, anonymous, and exported by the instance — never by the browser. The
default is **off**, and off means nothing is recorded, not merely nothing sent.

## Levels

Set in Settings → Telemetry (`settings.telemetry_level`). Each level includes
the ones before it.

| Level | Events |
|---|---|
| `off` (default) | Nothing. |
| `minimal` | `app.install`, `app.update`, `error.client`, `error.server`, `user.feedback`, `survey.response` |
| `extended` | `vehicle.added`, and daily `instance.stats` (table row counts, version) and `vehicle.stats` (model and year from the VIN, odometer, pack capacity and degradation, firmware) |

What is *never* sent, at any level: the VIN, coordinates, addresses, place or
car names, the Tesla account, or any credential. The only identity is
`service.instance.id`, a random UUID minted on first use
(`settings.telemetry_instance_id`).

## How it leaves

Events are written to the `telemetry_queue` outbox when they happen and
exported by the cron (the same ten-minute block as the update check) as
OTLP/HTTP JSON to `POST {endpoint}/v1/logs` — see `src/core/telemetry.ts`. The
endpoint is `DEFAULT_TELEMETRY_ENDPOINT` in `shared/telemetry.ts`, overridable
per deployment with the `TELEMETRY_ENDPOINT` var. The default ships empty, and
while the endpoint is empty nothing leaves the instance whatever the level. A collector that is down costs nothing: batches are
retried across cron runs, rows that fail ten flushes are dropped, and the
outbox is capped at 500 rows. Demo instances never flush at all — the cron
skips them.

`app.install` fires the first time telemetry is enabled, `app.update` when the
running version differs from the last one reported. The version stamp only
moves while telemetry is on, so opting in late still reports the install.

## Crash reports and feedback

With telemetry on, the SPA listens for `error` and `unhandledrejection`
(`app/components/TelemetryPrompts.tsx`), queues an `error.client` event (deduplicated,
at most five a session), and shows a toast offering a free-text box; the text
becomes a `user.feedback` event. Unhandled route errors on the server land in
`app.onError` and queue `error.server` the same way. Every write re-checks the
level server-side, so a stale client cannot over-share.

## Surveys

Surveys ship in the `surveys` array of `shared/surveys.json`, and are only
offered while telemetry is on. One entry:

```jsonc
{
  "id": "example-survey",        // unique forever — the response row is keyed on it
  "minAppVersion": "0.4.0",      // offered once an instance runs this or newer
  "sampleRate": 0.25,            // share of instances asked; rolled once per instance
  "minDelayMinutes": 30,         // shown at a random moment inside this window,
  "maxDelayMinutes": 1440,       //   drawn once per browser
  "title": "…",
  "description": "…",
  "questions": [
    { "id": "satisfaction", "type": "scale", "label": "…", "min": 1, "max": 5,
      "minLabel": "Not at all", "maxLabel": "Very" },
    { "id": "most-used", "type": "select", "label": "…", "options": ["…"] },
    { "id": "comments", "type": "text", "label": "…" }
  ]
}
```

The sampling roll happens server-side, exactly once, and its outcome —
`offered`, `sampled_out`, later `answered` or `dismissed` — is a row in
`survey_responses`; whatever the outcome, the survey is never offered again.
Answers are stored in that row and queued as a `survey.response` event.
Dismissals (the button, Escape, anything that closes the dialog) count as
settled too. The shipped example rides with `minAppVersion: "99.0.0"` so it is
never offered; to run a real survey, copy it, set a real version and rate, and
release.
