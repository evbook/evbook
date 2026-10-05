---
name: evbook-deploy
description: Deploy EVBook (a self-hosted EV logbook, currently for Tesla vehicles) to the user's own Cloudflare account, or upgrade an existing deployment. Use when the user wants to install, deploy, set up, host, or update EVBook, or asks for help with an EVBook deployment that is failing (401 loops, car not sleeping, rate limits, missing data).
---

# Deploy EVBook to Cloudflare

You are setting up EVBook — an EV logbook (currently for Tesla vehicles) that runs as a single
Cloudflare Worker with a D1 (SQLite) database and an R2 bucket for uploaded
documents — in the user's own Cloudflare
account. Everything runs on Cloudflare's free plan for typical single-car use.

Work through the phases in order. Every step is idempotent, so a re-run is
always safe and is the correct way to upgrade an existing deployment.

## Rules that must not be broken

1. **Never ask the user to paste a secret into the chat.** Not the app
   password, not `ENCRYPTION_KEY`, not Tesla tokens. Secrets go in via
   `wrangler secret put` (which prompts in their terminal) or via the app's own
   web form. If a user pastes a secret anyway, tell them plainly that it is now
   in the conversation and they should rotate it.
2. **Tesla tokens are entered in the app's browser UI, never through you.**
3. **Never run `wrangler d1 execute` with destructive SQL** (`DROP`, `DELETE`,
   `UPDATE` without a `WHERE`) against a database that already holds the user's
   history. Migrations are the only sanctioned schema change.
4. If a command fails, show the user the actual error and fix the cause. Do not
   retry the same command and do not invent a workaround that skips a step.

## Phase 1 — Preflight

```bash
node --version
npx wrangler --version
npx wrangler whoami
```

- Node must be 22 or newer. If it is older, stop and ask the user to upgrade.
- `wrangler whoami` failing means they are not logged in. Ask them to run
  `npx wrangler login` themselves (it opens a browser for OAuth) and tell you
  when it is done. Confirm with `npx wrangler whoami` and **read back the
  account name and email** so they can verify it is the right account before
  anything is created.

Then detect whether this is a fresh install or an upgrade:

```bash
npx wrangler deployments list --name evbook 2>/dev/null | head -5
npx wrangler d1 list
```

If a Worker named `evbook` and a database named `evbook` already exist,
this is an **upgrade**: skip to Phase 4 (build and deploy), and do not touch
secrets that are already set.

## Phase 2 — Nothing to provision by hand

`wrangler.jsonc` deliberately carries no resource ids: `npm run deploy`
resolves — or creates — the `evbook` D1 database and the `evbook-documents` R2
bucket by name in whichever account is logged in. Do **not** add a
`database_id` to `wrangler.jsonc`. If the user's wrangler is too old to
provision R2 on deploy and the deploy fails on the bucket, create it once:

```bash
npx wrangler r2 bucket create evbook-documents
```

Migrations are bundled into the Worker and apply themselves on the first
request after a deploy, so there is no `migrations apply` step either.

## Phase 3 — Secrets

EVBook needs exactly two secrets. It refuses to run without them and shows a
setup page instead, so this cannot be skipped.

**`ENCRYPTION_KEY`** encrypts the Tesla tokens at rest. Generate a strong value
and pipe it in without ever printing it:

```bash
npx wrangler secret put ENCRYPTION_KEY --name evbook < <(openssl rand -base64 32)
```

If the shell does not support process substitution, write to a temporary file
with `umask 077`, pipe the file in, then delete it. Never echo the value.

**Warn the user clearly:** if `ENCRYPTION_KEY` is ever lost or changed, the
stored Tesla tokens can no longer be decrypted and they will have to sign in to
Tesla again. Their logged history is unaffected.

**`APP_PASSWORD`** is what they will log in with. This one is theirs to choose,
so hand it to them:

```bash
npx wrangler secret put APP_PASSWORD --name evbook
```

Tell them to run that themselves and type a password at the prompt. Confirm
afterwards, which lists names only and never values:

```bash
npx wrangler secret list --name evbook
```

## Phase 4 — Build and deploy

```bash
npm install
npm run deploy
```

`npm run deploy` builds the front-end and then runs `wrangler deploy`. Report
the `workers.dev` URL from the output.

Sanity-check it before handing over:

```bash
curl -s https://<their-worker-url>/health_check
curl -s https://<their-worker-url>/api/v1/session
```

The first must return `{"ok":true}`. The second must return
`"setupRequired":false` — if it says `true`, a secret from Phase 3 is missing.

## Phase 5 — First run (the user drives this part)

Give them these steps and wait:

1. Open the URL and log in with the `APP_PASSWORD` they chose.
2. Get a Tesla access + refresh token pair. On a computer, the Connect screen
   links EVBook's own **Token Helper** browser extension (source in
   `extension/` of this repository), which signs in on Tesla's page and hands
   back the pair. On a phone, point them at TeslaMate's list of token apps at
   <https://docs.teslamate.org/docs/faq#how-to-generate-your-own-tokens>; do
   not recommend a specific third-party app yourself.
3. Paste the access and refresh tokens into EVBook's Connect screen. EVBook
   validates them immediately by performing a refresh, so a bad pair is
   rejected on the spot.
4. Their cars should appear on the overview page within a few seconds.

## Phase 6 — Verify it actually works

Do not declare success until these pass. Logging starts within about a minute
of sign-in; a once-a-minute cron keeps parked cars polled regardless.

1. **Cars discovered** — the overview lists their vehicles.
2. **State is being recorded** — the card shows a state (Online, Asleep,
   Offline, …) and a "for N min" duration that grows.
3. **The car can still sleep.** This is the most important check and the one
   users care most about. Park the car, leave it locked and unplugged with
   sentry mode off, and within roughly 30–40 minutes the state should go to
   Falling asleep and then Asleep. If it does not, the card names the reason
   under "Cannot sleep:" — read it out.
4. **A drive is logged** — after any short drive, it appears under Drives with
   a distance and a route map.

Point them at Settings for units, time zone, and the per-car sleep timings, and
tell them the defaults are the safe ones.

## Phase 7 — Optional hardening

Mention these; do not do them unasked.

- **Custom domain**: add a `routes` entry in `wrangler.jsonc` and redeploy.
- **Cloudflare Access** in front of the Worker, in addition to the app
  password, for SSO and per-person access.
- **Backups**: D1 has 30 days of point-in-time recovery. A manual snapshot is
  `npx wrangler d1 export evbook --remote --output evbook-backup.sql`.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Setup page keeps showing | `APP_PASSWORD` or `ENCRYPTION_KEY` missing. Check `wrangler secret list --name evbook`, then redeploy. |
| "Tesla tokens are invalid" | The refresh token is stale or was already consumed. Generate a fresh pair and sign in again. |
| Banner: tokens can no longer be decrypted | `ENCRYPTION_KEY` changed. Sign in to Tesla again; history is intact. |
| No data, state stuck on Unknown | Check `npx wrangler tail evbook` while it polls. Look for 401 (token), 429 (rate limit) or "Not signed in". |
| Rate limited (429) | Tesla throttles by account and IP. EVBook honours `retry-after` and resumes on its own. Do not redeploy in a loop — that does not help. |
| Car never sleeps | Read the "Cannot sleep:" reason on the card. Sentry mode and a driver present are the usual culprits; both are the car's doing, not EVBook's. Raising "Idle time before sleeping" makes it wait longer before trying. |
| Car sleeps but no drives appear | Drives shorter than 10 m or with fewer than two samples are discarded by design. |
| Positions missing for the first seconds of a drive | Expected in this version: EVBook polls rather than streaming, and requires two consecutive online readings before waking the car. |
| Worker exceeded limits | Check the Cloudflare dashboard. Typical single-car use fits the free plan; heavy multi-car use may need the $5/month Workers Paid plan. |

## What EVBook deliberately does not do

Say so plainly if asked, rather than implying it is broken or coming soon:
MQTT publishing (so no direct Home Assistant integration yet — there is a
proposal in `docs/proposals/home-assistant.md`), the Tesla streaming API, and
the official Fleet API. Imports come from Tessie exports only. The JSON API
(`docs/api.md`) is the integration surface for now.
