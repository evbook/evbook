# The Cloudflare CLI (`cf`) and wrangler

EVBook's Worker is developed and deployed with **`cf`**, the Cloudflare CLI that
supersedes wrangler ([docs](https://developers.cloudflare.com/cf/)). `cf` is
still in beta and does not do everything wrangler does yet, so the repository
carries both configurations and uses each for what it is good at.

## Two config files, one Worker

| File | Read by | Purpose |
|---|---|---|
| [`cloudflare.config.ts`](../cloudflare.config.ts) | `cf dev`, `cf build`, `cf deploy` | The Worker: bindings, vars, cron, Durable Object classes |
| [`wrangler.config.ts`](../wrangler.config.ts) | `cf build` (it bundles with wrangler) | Build settings only — the assets directory |
| [`wrangler.jsonc`](../wrangler.jsonc) | wrangler, the vitest pool, older forks' deploy workflows | The same Worker, in wrangler's format |

`npm run test:cf-config` (part of `npm test`) replays both and fails when they
describe different Workers — a var added to one and not the other, a changed
cron, a Durable Object class missing from `exports`. **Change both files
together.**

`wrangler.jsonc` stays because:

- `@cloudflare/vitest-pool-workers` reads a wrangler config (`vitest.config.ts`
  derives `wrangler.vitest.jsonc` from it).
- `cf` cannot yet stream logs (`wrangler tail`).
- Forks run *their own* copy of the deploy workflow, which may predate `cf`
  and runs `wrangler deploy` against whatever tag it installs.
- Tags cut before `cloudflare.config.ts` existed only have `wrangler.jsonc`;
  the current deploy workflow falls back to wrangler for them (on an
  installation that has never run a newer release — see the `exports` note).

## Commands

| Task | `cf` (default) | wrangler (still works) |
|---|---|---|
| Local worker on :8787 | `npm run dev` → `cf dev` | `npx wrangler dev` |
| Deploy | `npm run deploy` → `cf deploy` | `npm run deploy:wrangler` |
| Validate a deploy without credentials | `npx cf deploy --dry-run` | `npx wrangler deploy --dry-run` |
| Sign in | `npx cf auth login`, `npx cf auth whoami` | `npx wrangler login` |
| Remote D1 migrations | `npm run migrate:remote` (looks the ID up by name) | `npm run migrate:remote:wrangler` |
| Local D1 migrations | — | `npm run migrate:local` |
| First install: secrets + deploy | `npm run setup` | `npx wrangler secret put <NAME>`, then `npm run deploy:wrangler` |
| Change the app password | `npm run setup -- --password` | `npx wrangler secret put APP_PASSWORD` |
| Set the update token | `npm run setup -- --github-token` | `npx wrangler secret put UPDATE_GITHUB_TOKEN` |
| List secret names | `npx cf workers secrets list --worker evbook` | `npx wrangler secret list` |
| Live logs | — | `npx wrangler tail evbook` |
| Deployments | `npx cf workers deployments list --worker evbook` | `npx wrangler deployments list` |
| Find any other command | `npx cf cli search "<what you want to do>"` | |

`cf` is a pinned dev dependency, so `npx cf` runs the project's copy. A global
`npm install -g cf` also hands every command to the project's copy.

## What differs, and how EVBook handles it

- **`UPDATE_REPO` at deploy time.** `cf deploy` has no `--var`. The config is
  TypeScript, so it reads `process.env.UPDATE_REPO`; the deploy workflow exports
  it as the repository it runs in.
- **`keep_vars` is gone.** `cf deploy` replaces every plain-text var with the
  config's values, and drops vars that exist only in the dashboard. EVBook
  reads no undeclared vars, so nothing is lost — and a dashboard edit to a
  *declared* var was overwritten on every deploy with wrangler too. **Secrets
  are always kept** (`cf` uploads every version with `keep_secrets`).
- **Durable Objects: `exports`, not `migrations` — a one-way switch.** Both
  files declare every live class with its storage in an `exports` map (the
  project's wrangler, 4.158, reads it too). The first deploy with `exports` — by either tool —
  moves the Worker over, and from then on Cloudflare **rejects any deploy that
  still carries `migrations`** ("Durable Object exports reconciliation
  failed"). So a release cut before this change (its `wrangler.jsonc` has
  `migrations`) can no longer be deployed onto an installation that has run a
  newer one. Renaming or deleting a class needs a tombstone in *both* maps
  ([how](https://developers.cloudflare.com/cf/wrangler/reference/#convert-durable-object-migrations));
  the parity check compares the classes each leaves live.
- **Secrets are not declared in `cloudflare.config.ts`.** `bindings.secret()`
  makes `cf deploy` refuse to run until the secret is set; EVBook has to
  deploy without them (and show its Setup page), and `UPDATE_GITHUB_TOKEN` is
  optional anyway. `Env` gets the secret names from `wrangler types`.
- **Setting secrets without wrangler.** `cf` has no prompting `secret put`
  (`cf workers secrets update` takes the value as an argument, which lands in
  shell history). `npm run setup` ([`scripts/setup.mjs`](../scripts/setup.mjs))
  instead passes `cf deploy --secrets-file` a temporary file holding only the
  secret *names*; `cf` takes the values from the environment, so they reach
  neither the disk nor a command line. It reads the Worker's existing secret
  names first and never regenerates an `ENCRYPTION_KEY` that is already set.
- **Resource IDs.** Neither config carries one. `cf deploy` provisions the D1
  database and R2 bucket by name, like wrangler. `cf d1 …` commands take the
  database ID; `npm run migrate:remote` resolves it with `cf d1 list --name evbook`.
- **Local data.** `cf dev` delegates to wrangler, so the dev database is still
  under `.wrangler/state`. `cf d1 … --local` uses a *different*, machine-wide
  store, so use the wrangler commands to seed or inspect the dev database
  (`npm run migrate:local`, `npx wrangler d1 execute evbook --local …`).
- **`cf dev` flags.** Unknown flags reach wrangler's dev server (`--port`
  works), but `cf` rejects some itself — `--inspector-port`, for one.
- **Credentials.** `cf` reads `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`
  from the environment *and from a `.env` file in the current directory*.
  `.env` here is the Node runtime's config; if it holds a Cloudflare token,
  `cf` uses that token in preference to `cf auth login`.
- **Build output** goes to `.cloudflare/` (gitignored), next to `.wrangler/`.
  While `.cloudflare/output` exists, `wrangler deploy` refuses to run (it might
  deploy the wrong Worker); `npm run deploy:wrangler` deletes it first.
- **Telemetry.** `cf` sends anonymous usage telemetry; CI sets
  `CF_SEND_TELEMETRY=false`, and so can you.

## Verified against real Workers

On 2026-11-09, scratch Workers in a real account (secrets, a login session, a
Durable Object import job and a D1 setting as markers) went through: wrangler
with `migrations` → `cf deploy` → wrangler with `exports` → `cf deploy` again,
and separately wrangler `migrations` → wrangler `exports` (an older fork
workflow installing a new tag). Every marker survived every step; secrets were
kept by both tools. `npm run migrate:remote` resolved the database by name and
applied nothing new, matching `d1_migrations`. `npm run setup` was run on a
fresh Worker (both secrets set, stored as `secret_text`, login works), re-run
(nothing asked, key kept — an existing session stayed valid), and re-run with
`--password` (old password refused, new one accepted, session still valid).

## Upgrading `cf`

It is pinned exactly (`"cf": "1.0.0-beta.N"`), because beta releases may change
commands and config. After bumping it, run `npm test` (the parity check
evaluates `cloudflare.config.ts`) and `npx cf deploy --dry-run`. `cf` needs
wrangler 4.136 or newer in the project to build.
