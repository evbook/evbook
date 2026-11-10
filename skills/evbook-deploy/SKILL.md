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

EVBook deploys with **`cf`**, the Cloudflare CLI (beta), pinned in the project
— always run it as `bunx cf`. The only thing still on wrangler is live logs
(`bunx wrangler tail`), for troubleshooting. `docs/cloudflare-cli.md` has
the full mapping; to find a `cf` command for anything else, run
`bunx cf cli search "<task>"` rather than guessing or chaining `--help`.

## Rules that must not be broken

1. **Never ask the user to paste a secret into the chat.** Not the app
   password, not `ENCRYPTION_KEY`, not Tesla tokens. Secrets go in via
   `bun run setup`, which the user runs in their own terminal (it prompts
   without echoing and generates the key itself), or via the app's own web
   form. If a user pastes a secret anyway, tell them plainly that it is now
   in the conversation and they should rotate it.
2. **Tesla tokens are entered in the app's browser UI, never through you.**
3. **Never run `cf d1 query` / `wrangler d1 execute` with destructive SQL** (`DROP`, `DELETE`,
   `UPDATE` without a `WHERE`) against a database that already holds the user's
   history. Migrations are the only sanctioned schema change.
4. If a command fails, show the user the actual error and fix the cause. Do not
   retry the same command and do not invent a workaround that skips a step.

## Phase 1 — Preflight

```bash
bun --version
node --version
bun install
bunx cf --version
bunx cf auth whoami
```

- Bun must be 1.4 or newer (it installs and runs the project's scripts), and
  Node 22.18 or newer (`cf` requires it). If either is missing or older, stop and ask
  the user to upgrade.
- `cf auth whoami` failing means they are not signed in to `cf`. Ask them to
  run `bunx cf auth login` themselves (it opens a browser) and tell you when it
  is done. **Read back the account name and email** so they can verify it is
  the right account before anything is created.
- If the repo has a `.env` with a `CLOUDFLARE_API_TOKEN`, `cf` uses that token
  instead of the login. Point this out if the accounts do not match.
- If the login can see several accounts, set `CLOUDFLARE_ACCOUNT_ID` for the
  session so every command targets the same one.

Then detect whether this is a fresh install or an upgrade:

```bash
bunx cf workers deployments list --worker evbook
bunx cf d1 list --name evbook
```

If a Worker named `evbook` and a database named `evbook` already exist,
this is an **upgrade**: skip to Phase 4 (deploy), and do not touch secrets
that are already set.

## Phase 2 — Nothing to provision by hand

`cloudflare.config.ts` (and its twin `wrangler.jsonc`) deliberately carry no
resource ids: `bun run deploy` resolves — or creates — the `evbook` D1 database
and the `evbook-documents` R2 bucket by name in whichever account is signed in.
Do **not** add an `id`/`database_id` or an `accountId` to either file. If the
deploy fails on the bucket, create it once:

```bash
bunx cf r2 buckets create --name evbook-documents
```

Migrations are bundled into the Worker and apply themselves on the first
request after a deploy, so there is no `migrations apply` step either.

## Phase 3 — Secrets and first deploy (fresh install only)

EVBook needs exactly two secrets. It refuses to run without them and shows a
setup page instead, so this cannot be skipped. One command sets both and
deploys — **the user runs it in their own terminal**, because it asks for
their password:

```bash
bun run setup
```

It generates `ENCRYPTION_KEY` itself (never printed), asks for `APP_PASSWORD`
twice without echoing it, builds, and runs `cf deploy` with the two values
passed through the environment — they never touch the disk or a command line.
It only generates a key when the Worker has none, so a re-run never replaces
one; `bun run setup --password` changes just the password.

**Warn the user clearly:** if `ENCRYPTION_KEY` is ever lost or changed, the
stored Tesla tokens can no longer be decrypted and they will have to sign in to
Tesla again. Their logged history is unaffected.

When they say it is done, confirm — names only, never values — and take the
`workers.dev` URL from their output:

```bash
bunx cf workers secrets list --worker evbook
```

## Phase 4 — Deploy (upgrades)

```bash
bun run deploy
```

`bun run deploy` builds the front-end and then runs `cf deploy`, which keeps
every secret already set. Report the `workers.dev` URL from the output. If
`cf` itself fails in a way the error does not explain (it is beta),
`bun run deploy:wrangler` deploys the same Worker with wrangler (after
`bunx wrangler login`) — say that you switched, and why.

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
   links EVBook's own **Token Helper** browser extension, which signs in on Tesla's page and hands
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

- **Custom domain**: add `domains: ["…"]` under `worker` in
  `cloudflare.config.ts` (and a matching `routes` entry with
  `custom_domain: true` in `wrangler.jsonc` — `bun run test` checks they match), then
  redeploy.
- **Cloudflare Access** in front of the Worker, in addition to the app
  password, for SSO and per-person access.
- **Backups**: D1 has 30 days of point-in-time recovery. A manual snapshot is
  `bunx wrangler d1 export evbook --remote --output evbook-backup.sql`
  (no `cf` equivalent yet; needs `bunx wrangler login` once).

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Setup page keeps showing | `APP_PASSWORD` or `ENCRYPTION_KEY` missing. Check `bunx cf workers secrets list --worker evbook`, then redeploy. |
| "Tesla tokens are invalid" | The refresh token is stale or was already consumed. Generate a fresh pair and sign in again. |
| Banner: tokens can no longer be decrypted | `ENCRYPTION_KEY` changed. Sign in to Tesla again; history is intact. |
| No data, state stuck on Unknown | Check `bunx wrangler tail evbook` while it polls (`cf` cannot stream logs yet). Look for 401 (token), 429 (rate limit) or "Not signed in". |
| `cf deploy` errors with "More than one account available" | Set `CLOUDFLARE_ACCOUNT_ID` to the account read back in Phase 1. |
| `cf` uses the wrong account | A `CLOUDFLARE_API_TOKEN` in the environment or in `./.env` beats `cf auth login`. Unset it for the session. |
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
