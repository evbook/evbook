---
name: evbook-demo
description: Deploy or update EVBook's public showcase on a VPS — the demo app at demo.evbook.app (DEMO mode, fixture data) and the landing page at evbook.app. Use when the user wants to publish, redeploy, update, roll back or troubleshoot the demo or the landing site, set up a new VPS to host them, wire up the deploy-demo GitHub workflow, or refresh the demo's fixture world. Not for installing EVBook for real — that is the evbook-deploy skill.
---

# Deploy the EVBook showcase to a VPS

This is how the project hosts its own public demo — kept as a worked example
of a CI-to-VPS deploy, not an install path.

Two public things, one pipeline:

| Host | What it is | How it is served |
|---|---|---|
| `demo.evbook.app` | The whole app with `DEMO=true` against a generated fixture world | Node under PM2 on `127.0.0.1:3100`, proxied by Caddy |
| `evbook.app`, `www.evbook.app` | The landing page in [`site/`](../../site/) | Caddy `file_server` — no process at all |

This is **not** how anybody runs EVBook for real. Real installs go to
Cloudflare (`evbook-deploy` skill) or Docker (`docs/vps.md`). If the user wants
to log an actual car, you are in the wrong skill — say so and switch.

## Rules that must not be broken

1. **Assume the VPS is shared.** The box may host other sites and PM2 apps, so
   EVBook never edits their config. Every change you make is additive: never
   edit a Caddy site block or PM2 ecosystem file that EVBook did not install,
   never `pm2 delete` something you did not create, never restart Caddy when a
   reload will do.
2. **`caddy validate` before every reload.** A bad snippet must not be able to
   take any other site on the box offline. Caddy keeps the running config if validation
   fails — so validate, then reload.
3. **Never put a secret in the demo's environment.** Demo mode needs no
   `APP_PASSWORD` and no `ENCRYPTION_KEY` (`src/app.ts` short-circuits auth when
   `DEMO=true`). If you find either set on this box, remove it: a public URL
   with a real encryption key on it is a liability, not a feature.
4. **Do not disable `DEMO=true`,** and do not point the demo at a real database.
   Every Tesla-facing endpoint answers `demo_mode` only because that flag is on.
5. If a command fails, show the user the real error and fix the cause. Do not
   retry blindly, and do not work around a failed health check by skipping it.

## The layout on the box

```
/srv/evbook/
  releases/<sha>/   dist/ migrations/ demo/ e2e/mocks/ site/ ecosystem.config.cjs
  current -> releases/<sha>
  data/             evbook.sqlite (+ WAL) — owned by the `evbook` user, survives releases
  reseed.sh         rebuilds the fixture world
```

`current` is a symlink and the last five releases are kept, so a rollback is a
symlink flip. `data/` lives outside the releases, so a deploy replaces code and
never data.

Supporting pieces, all installed by `bootstrap.sh`:

- `evbook` — a `--system` user with no shell. PM2 runs as root; the
  app process drops to this user via `uid`/`gid` in the ecosystem file.
- `/etc/caddy/sites/evbook.caddyfile` — pulled in by one `import` line appended
  to the main Caddyfile.
- `evbook-demo-reseed.timer` — nightly at 04:17, rebuilds the fixture world.

## Phase 1 — Work out what you are doing

```bash
ssh <user@host> 'pm2 describe evbook-demo >/dev/null 2>&1 && echo INSTALLED || echo FRESH; \
  ls -l /srv/evbook/current 2>/dev/null; \
  systemctl is-active caddy; caddy version; node --version; pm2 --version'
```

- `FRESH` → this is a new host: Phase 2, then 3.
- `INSTALLED` → it is an update: skip to Phase 3.

Node must be 22.5 or newer (`node:sqlite`). Caddy and PM2 must already be
there — this skill adds EVBook to a working box, it does not build one.

Confirm DNS points at the box **before** deploying, or Caddy's HTTP-01
challenge will fail and it will back off:

```bash
for h in evbook.app www.evbook.app demo.evbook.app; do echo -n "$h -> "; dig +short A $h; done
```

All three must return the VPS address.

## Phase 2 — Bootstrap (new host only)

```bash
./deploy/vps/bootstrap.sh <user@host>
```

Creates the user and directories, installs the reseed script and its timer,
drops in the Caddy snippet, appends the `import` line if it is not already
there (backing the Caddyfile up first), validates and reloads Caddy. It is
idempotent — re-running it is the way to repair drift.

If `caddy validate` fails, read the error: it names the file and line. Fix
`deploy/vps/caddy/evbook.caddyfile` in the repo and re-run. Do not hand-edit
the copy on the server; the next bootstrap overwrites it.

## Phase 3 — Deploy

**Preferred — through CI**, so what is public matches what is in `main`:

```bash
gh workflow run deploy-demo --ref main
gh run watch "$(gh run list --workflow deploy-demo --limit 1 --json databaseId --jq '.[0].databaseId')"
```

`deploy-demo` also fires on every push to `main` that touches the app, the
site, the fixtures or the deploy scripts. Pass `-f bootstrap=true` to make the
run bootstrap first.

**By hand**, when CI is not an option:

```bash
bun install --frozen-lockfile
bun run build:app && bun run build:server
./deploy/vps/release.sh <user@host>
```

`release.sh` packs a tarball, unpacks it into a new release directory, flips
`current`, seeds the fixture world if there is not one yet, `pm2
startOrRestart`s the app, `pm2 save`s so it survives a reboot, waits for
`/health_check`, **rolls back to the previous release if it never gets
healthy**, and prunes to the last five.

Nothing is built on the VPS, by design: the `bun build` server bundle imports only
`node:` builtins, the fixture seeder needs only `node:sqlite`, and the landing
page is static. The box needs no npm and no registry credentials.

## Phase 4 — Verify

```bash
./deploy/vps/verify.sh
```

It checks, from the public internet: the landing page serves over TLS, `http`
and `www` redirect to the apex, `robots.txt` allows indexing, the demo is
healthy, reports `"demo":true` and `"setupRequired":false`, serves the app
shell and deep links, returns fixture cars **without a login**, refuses
`POST /api/v1/cars/1/wake` with `demo_mode`, and sends `X-Robots-Tag: noindex`.

Do not report success until it passes. Then open `https://demo.evbook.app` and
confirm two cars with history actually render — the API answering is not the
same as the app looking right.

## Phase 5 — The fixture world

The demo world is generated **relative to "now"**, so a database seeded months
ago shows a car that stopped driving months ago. A timer rebuilds it nightly:

```bash
ssh <user@host> 'systemctl list-timers evbook-demo-reseed --all'
ssh <user@host> '/srv/evbook/reseed.sh'                       # rebuild right now
ssh <user@host> 'journalctl -u evbook-demo-reseed -n 50'      # what the last one did
```

Rebuilding also discards whatever visitors edited — geofences, charge costs,
settings. For a public demo that is the point. Say so if the user asks why
their tweak vanished.

Change what the world *contains* in [`demo/world.mjs`](../../demo/world.mjs)
and redeploy; the generator is the same one the test suite uses.

## Phase 6 — Wiring up CI (once per repository)

The workflow needs four repository secrets. Generate the key yourself and pipe
it in — **never ask the user to paste a private key into the chat**:

```bash
ssh-keygen -t ed25519 -N '' -C 'github-actions deploy-demo' -f /tmp/evbook_deploy
ssh-copy-id -i /tmp/evbook_deploy.pub <user@host>          # or append to authorized_keys

gh secret set VPS_SSH_KEY < /tmp/evbook_deploy
gh secret set VPS_HOST --body '<ip>'
gh secret set VPS_USER --body '<user>'
ssh-keyscan -H <ip> | gh secret set VPS_SSH_KNOWN_HOSTS     # pin the host key

shred -u /tmp/evbook_deploy /tmp/evbook_deploy.pub
```

`VPS_SSH_KNOWN_HOSTS` is what makes the runner refuse to talk to an imposter;
without it the job would trust whatever answered.

## Rolling back

```bash
ssh <user@host> 'ls -1dt /srv/evbook/releases/*/'          # newest first
ssh <user@host> 'ln -sfn /srv/evbook/releases/<sha> /srv/evbook/current.new && \
                 mv -T /srv/evbook/current.new /srv/evbook/current && \
                 pm2 restart evbook-demo --update-env'
```

The symlink is swapped with `mv -T` rather than deleted and recreated, so there
is never an instant where `current` does not exist and Caddy 404s the landing
page.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| TLS fails / `SSL_ERROR_SYSCALL` on a new host | Caddy has no certificate yet. Check DNS resolves to the box and port 80 is reachable (HTTP-01 needs it), then `journalctl -u caddy -n 50`. Let's Encrypt rate-limits repeated failures — fix the cause before retrying. |
| Landing page 404s | `current` is missing or `site/` is not in the release. `ls -l /srv/evbook/current/site`. Caddy reads it as the `caddy` user, so the path must be world-traversable (`chmod -R a+rX`). |
| Demo shows the sign-in screen | `DEMO` is not `true` in the running process. `pm2 env $(pm2 id evbook-demo)`, then `pm2 restart evbook-demo --update-env`. |
| Demo shows the setup screen | Same cause — `setupRequired` is only computed when `DEMO` is off. |
| `502` from Caddy | The app is not listening on 3100. `pm2 logs evbook-demo --lines 50`. |
| PM2 keeps restarting it | `min_uptime`/`max_restarts` mean ten fast failures stop it. Read the logs; a corrupt fixture database is the usual cause — `/srv/evbook/reseed.sh`. |
| `SQLITE_READONLY` or `unable to open database` | `/srv/evbook/data` is not owned by `evbook`. `chown -R evbook:evbook /srv/evbook/data`. The reseed script does this; a hand-run seed as root does not. |
| Demo data is stale | The nightly timer is not firing. `systemctl status evbook-demo-reseed.timer`. |
| Deploy job cannot connect | `VPS_SSH_KNOWN_HOSTS` is stale (the host key changed) or the public key is not in `authorized_keys`. Re-run Phase 6. |
| Port 3100 is taken | Something else on the box claimed it. Change `PORT` in `deploy/vps/ecosystem.config.cjs` **and** the `reverse_proxy` in `deploy/vps/caddy/evbook.caddyfile` together, then bootstrap and release. |
| Another site on the box broke after a deploy | It should not be possible — nothing here writes outside `/srv/evbook`, `/etc/caddy/sites/` and the one `import` line. Restore `/etc/caddy/Caddyfile.bak-*` and tell the user what you found. |

## What the demo deliberately does not do

Say so plainly rather than treating it as a bug: no sign-in (there is nothing
to sign in to), no waking, navigation, account discovery or token entry, no
imports, and no document uploads — all answer `demo_mode`. Reads and
local-database writes (places, charge costs, settings) work fully, and are
wiped nightly. The demo is also `noindex`, so it will never appear in search
results for the product's own name.
