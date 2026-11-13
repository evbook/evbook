---
name: evbook-deploy
description: Deploy EVBook (a self-hosted EV logbook, currently for Tesla vehicles) to the user's own Cloudflare account, upgrade an existing deployment, or set up one-click updates for it (the in-app Update button, through a GitHub fork and its secrets). Use when the user wants to install, deploy, set up, host, or update EVBook, wants updates to be automatic or one click, or asks for help with an EVBook deployment that is failing (401 loops, car not sleeping, rate limits, missing data, an update that will not install).
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
   password, not `ENCRYPTION_KEY`, not Tesla tokens, not a Cloudflare API
   token, not a GitHub token. Secrets go in via `bun run setup` or
   `gh secret set`, which the user runs in their own terminal (both prompt
   without echoing; setup generates the key itself), or via a web form — the
   app's own, or GitHub's. If a user pastes a secret anyway, tell them plainly
   that it is now in the conversation and they should rotate it.
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
that are already set. If the user only asked for one-click or automatic
updates, go straight to Phase 7.

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

First see whether this instance already installs its own updates (Phase 7):

```bash
bunx cf workers secrets list --worker evbook
```

If `UPDATE_GITHUB_TOKEN` is listed, it does, and the simplest update is the
one it was set up for: the user presses **Update** in Settings → Version, or
you start the same workflow (ask which repository is their fork if you do not
know it):

```bash
gh workflow run deploy.yml --repo <owner>/evbook -f tag="$(gh release view --repo evbook/evbook --json tagName --jq .tagName)"
```

A deploy from this folder works too, but every deploy sets afresh the setting
that tells the app which repository to dispatch (`UPDATE_REPO`), so the folder
has to know the fork. `bun run setup --github-token` records it in the
checkout's git config; a fresh clone has no such record. Check before
deploying, and set it if nothing is printed:

```bash
git config --get evbook.updateRepo
git config evbook.updateRepo <owner>/evbook
```

Then, in either case:

```bash
git pull
bun install
bun run deploy
```

`bun run deploy` builds the front-end and then runs `cf deploy`, which keeps
every secret already set. Report the `workers.dev` URL from the output. If
`cf` itself fails in a way the error does not explain (it is beta),
`bun run deploy:wrangler` deploys the same Worker with wrangler (after
`bunx wrangler login`) — say that you switched, and why. wrangler does not
read the remembered fork, so with one-click updates set up, pass it:
`bun run deploy:wrangler -- --var UPDATE_REPO:<owner>/evbook`.

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

## Phase 7 — One-click updates (offer it; set it up if they say yes)

Out of the box, updating means coming back to a terminal: `git pull`,
`bun install`, `bun run deploy`. The app tells the user when a release is out
and its **Update** button recites those commands. With this phase done, the
same button asks once and installs the release by itself, through GitHub
Actions — the user never needs this folder again.

Offer it once the car is logging, or whenever the user asks for automatic or
one-click updates. Say what it costs before starting: a GitHub account, about
ten minutes, and two tokens that they create and enter themselves. If they
decline, stop here — nothing else depends on it.

How it works, so you can explain it and debug it: the user forks the EVBook
repository. The fork holds nothing but the `deploy` workflow and two
Cloudflare secrets; the workflow checks the code out of `evbook/evbook` at the
release tag and deploys it to their account. The Worker holds a GitHub token
that may start that one workflow, and a setting (`UPDATE_REPO`) naming the
fork. The fork never needs syncing.

Do the steps in this order. Each one ends with a check you run yourself.
`<owner>` is their GitHub user name; replace it everywhere below.

### 7.1 The GitHub CLI

```bash
gh auth status
```

It makes every step below one command. If it is missing or signed out, ask
the user to install it or run `gh auth login` themselves. If they would rather
not, every step has a browser route — given below — and you cannot run the
checks; ask them what they see instead.

### 7.2 Fork, and switch the fork's workflows on

Creating a fork puts a public repository in their account, so **ask before
you do it**. Then:

```bash
gh repo fork evbook/evbook --clone=false
gh repo view <owner>/evbook --json nameWithOwner,isFork
```

(In a browser: <https://github.com/evbook/evbook/fork>.) If they already have
a fork, use it — do not make a second one.

A fresh fork has its workflows switched off, and only the owner can switch
them on: ask the user to open `https://github.com/<owner>/evbook/actions` and
press **I understand my workflows, go ahead and enable them**. Check:

```bash
gh workflow list --repo <owner>/evbook
```

`deploy` must be listed as `active`. Do not go on until it is.

### 7.3 A Cloudflare API token for the fork (the user makes it)

Send them to <https://dash.cloudflare.com/profile/api-tokens> → **Create
Token** → **Custom token**, with exactly these **Account** permissions:

| Permission | Access |
|---|---|
| Workers Scripts | Edit |
| D1 | Edit |
| Workers R2 Storage | Edit |

and **Account Resources** limited to the account from Phase 1. R2 is needed
even when they do not use R2: the deploy asks the account whether it is
enabled. Cloudflare shows the token once. They copy it and keep it out of the
chat; the next step is where it goes.

### 7.4 The two Actions secrets

The token is a secret, so **the user runs this in their own terminal** — it
asks for the value and does not show it:

```bash
gh secret set CLOUDFLARE_API_TOKEN --repo <owner>/evbook
```

The account ID is not a secret. Read it from `bunx cf auth whoami` (Phase 1)
and set it yourself:

```bash
gh secret set CLOUDFLARE_ACCOUNT_ID --repo <owner>/evbook --body <account-id>
```

(In a browser: `https://github.com/<owner>/evbook/settings/secrets/actions/new`,
once for each name.) Check — names only, GitHub never shows values:

```bash
gh secret list --repo <owner>/evbook
```

Both names must be there, spelled exactly so.

### 7.5 A GitHub token for the Worker (the user makes it and enters it)

**The user runs this in their own terminal**, from this folder:

```bash
bun run setup --github-token
```

Tell them what it will do, so nothing surprises them:

1. It asks which repository deploys the instance. They answer `<owner>/evbook`.
2. It prints a link to GitHub's token form with the name, the owner and the
   permission (**Actions: Read and write**) already filled in. On that page
   they must still choose **Only select repositories** and pick
   `<owner>/evbook`, choose an expiry, and press **Generate token**.
3. It asks for the token without showing it, and tries it against the fork.
   A token that cannot see the fork's deploy workflow is refused with the
   reason, and nothing is deployed — fix what it names and run it again.
4. It deploys, with the token as the `UPDATE_GITHUB_TOKEN` secret and
   `UPDATE_REPO` set to the fork. Existing secrets are kept.
5. It records the fork in this checkout's git config
   (`evbook.updateRepo`), so a later `bun run deploy` from this folder keeps
   pointing the app at it.

Mention the expiry they chose: when the token lapses, **Update** will report
that GitHub refused it, and this step is how they renew it.

Check, names only:

```bash
bunx cf workers secrets list --worker evbook
```

`UPDATE_GITHUB_TOKEN` must be listed, beside the two from Phase 3.

### 7.6 Prove it: run the fork's workflow once

This is the same thing the Update button will do, started by hand. It proves
the Cloudflare secrets, and it leaves the Worker on the newest release with
`UPDATE_REPO` set by the workflow itself. Tell the user it deploys the newest
release — if they were behind, this is also their update.

```bash
gh workflow run deploy.yml --repo <owner>/evbook -f tag="$(gh release view --repo evbook/evbook --json tagName --jq .tagName)"
gh run list --repo <owner>/evbook --workflow deploy.yml --limit 1
```

(In a browser: the fork's Actions tab → **deploy** → **Run workflow**, with
the tag from <https://github.com/evbook/evbook/releases/latest>.) It takes a
couple of minutes. Follow it with `gh run watch --repo <owner>/evbook <run-id>`
and do not call the phase done until the run is green. If it is red, read it —
`gh run view --repo <owner>/evbook <run-id> --log-failed` — and go by the step
that failed:

| Failed step | Cause and fix |
|---|---|
| Deploy the worker — authentication or permission error | `CLOUDFLARE_API_TOKEN` is wrong or lacks Workers Scripts: Edit. Redo 7.3 and 7.4. |
| Deploy the worker — "Could not tell whether R2 is enabled" | The token lacks Workers R2 Storage: Edit. Redo 7.3 and 7.4. |
| Deploy the worker — account not found, or the wrong account | `CLOUDFLARE_ACCOUNT_ID` is not the account from Phase 1. Set it again (7.4). |
| Apply D1 migrations | The token lacks D1: Edit. Redo 7.3 and 7.4. |

Then repeat the Phase 4 sanity check against their URL, and ask the user to
open Settings → Version: the **Updates** line must read "One click, from here".
There is nothing to click until the next release; when it comes, **Update**
asks once, shows the deploy as it runs, and offers a reload when it is live.

### 7.7 What to tell them to remember

- Updates now come through the Update button (or the fork's workflow). A
  `bun run deploy` from this folder still works and keeps the fork setting,
  because the folder remembers it. A **fresh clone** does not: before deploying
  from one, run `git config evbook.updateRepo <owner>/evbook`. If the setting
  is ever lost, the Update button says so, and running the fork's workflow
  once (7.6) puts it back.
- The GitHub token expires on the date they chose. Renewing it is 7.5 again.
- To turn one-click updates off: delete the token on GitHub, then take it
  off the Worker with
  `bunx cf workers secrets delete UPDATE_GITHUB_TOKEN --worker evbook`. The
  Update button goes back to walking them through the commands. (Deleting it
  on GitHub alone leaves a button that asks, tries, and is refused.)

## Phase 8 — Optional hardening

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
| **Update** says "GitHub refused the dispatch" or "GitHub answered 404" | If the message adds "UPDATE_REPO is not set", a deploy from a folder that did not know the fork (a fresh clone, or `bun run deploy:wrangler`) cleared it: run the fork's workflow once (Phase 7.6), and `git config evbook.updateRepo <owner>/evbook` in that folder. Otherwise the GitHub token expired, or is not for that repository with Actions: Read and write: redo Phase 7.5. |
| **Update** starts, then reports the deploy finished with "failure" | The fork's workflow ran and went red: `gh run list --repo <owner>/evbook --workflow deploy.yml --limit 1`, then the table in Phase 7.6. The running instance is untouched. |
| Settings shows "Updates: By hand" after Phase 7 | `UPDATE_GITHUB_TOKEN` is not on the Worker (`bunx cf workers secrets list --worker evbook`). Redo Phase 7.5. |
| Worker exceeded limits | Check the Cloudflare dashboard. Typical single-car use fits the free plan; heavy multi-car use may need the $5/month Workers Paid plan. |

## What EVBook deliberately does not do

Say so plainly if asked, rather than implying it is broken or coming soon:
MQTT publishing (so no direct Home Assistant integration yet — there is a
proposal in `docs/proposals/home-assistant.md`), the Tesla streaming API, and
the official Fleet API. Imports come from Tessie exports only. The JSON API
(`docs/api.md`) is the integration surface for now.
