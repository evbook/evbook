# Updating

The app tells you when there is something to update to. On Cloudflare it can
also install the update for you (below); otherwise updating is two commands.

On a VPS:

```bash
docker compose pull && docker compose up -d
```

On Cloudflare:

```bash
git pull && npm run deploy
```

Migrations apply themselves — at boot on a VPS (`node dist/server/main.js
--migrate-only` runs them ahead of a swap if you would rather have the schema
settled first), and on the first request on Cloudflare — and your logged
history is never touched by either.

## The in-app Install button (Cloudflare)

The update notice on its own is just a notice — but a Cloudflare deployment can
be given an **Install** button in Settings that deploys the new release for you, by
dispatching the repository's `deploy` workflow on GitHub Actions. The instance
keeps serving while Actions builds the tag, applies migrations and replaces the
worker from outside; nothing tries to redeploy itself from within. (Migrations
also apply themselves at the new worker's first request, so even a plain
`npm run deploy` needs no separate migrate step.)

Every installation is independent, so the moving parts are arranged for the
fork model: your fork holds nothing but the workflow and your two Cloudflare
secrets, while the deploy checks the code out of the release repo at the tag
being installed — a fork never needs its tags synced, and the Worker config
carries no per-account state. The workflow deploys with `cf` when the tag has a
`cloudflare.config.ts`, and with wrangler for older tags
([cloudflare-cli.md](./cloudflare-cli.md)). The workflow even sets `UPDATE_REPO` itself, to
the repository it runs in, so the app dispatches your fork's workflow next
time without you configuring anything.

To enable it:

1. In the GitHub repository you deploy from (your fork, if you use one), add
   two Actions secrets: `CLOUDFLARE_API_TOKEN` (Workers Scripts:Edit, D1:Edit,
   Workers R2 Storage:Edit) and `CLOUDFLARE_ACCOUNT_ID`.
2. Give the worker a token allowed to start that workflow:

   ```bash
   npm run setup -- --github-token   # fine-grained, Actions read/write on that one repo
   ```

Without the token everything stays as it was: the app tells you about the
release and Settings recites the two commands. (The *check* for new releases
needs no token — though keeping one set is still kinder to GitHub's shared
rate limits for Workers.)

## How the notice works

Every ten minutes the cron reaches the update check, which asks GitHub for the
repository's tags at most once a day (**Check now** in Settings asks
immediately) — one request from the server, not from your browser, so no
visitor's address reaches GitHub and one instance asks once however many phones
are pointed at it. It is anonymous unless `UPDATE_GITHUB_TOKEN` is set. A
newer version than the running build puts a dismissible notice in the corner; "×" silences that
version for a week, and a version newer still gets to speak up once.
`DISABLE_UPDATE_CHECK=true` (in `.env`, or as a Worker var) stops the asking
altogether, and Settings then says so rather than implying you are up to date.
`UPDATE_CHANNEL` picks the channel (default `stable`); a fork that tags its own
releases points `RELEASE_REPO` in [`shared/version.ts`](../shared/version.ts) at
itself.

## Releases are tags

`v<major>.<minor>.<patch>-<channel>`, e.g. `v0.2.0-stable`. `stable` is the
only channel published; the suffix has been there since the first tag so that
adding a `canary` one later cannot make already-installed instances start
offering pre-releases. To cut one:

```bash
npm version minor --no-git-tag-version   # package.json, package-lock.json and shared/version.ts
git commit -am "release: 0.2.0"
git tag v0.2.0-stable
git push && git push origin v0.2.0-stable
```

Pushing the tag also publishes the Docker image (`release-image` workflow):
`ghcr.io/evbook/evbook:<version>` for amd64 and arm64, and `:latest` for a
stable release.

[`shared/version.ts`](../shared/version.ts) carries the version the build
reports; [`scripts/sync-version.mjs`](../scripts/sync-version.mjs) runs from
npm's `version` lifecycle to keep it level with package.json, and a test fails
if the two ever disagree. A tag with no channel suffix is ignored by every
instance, so tagging for anything other than a release is harmless.
