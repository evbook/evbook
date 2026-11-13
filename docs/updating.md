# Updating

The app tells you when there is something to update to, and **Update** in
Settings → Version takes it from there. On Cloudflare with one-click updates
set up (below) it asks once and installs the release for you. Otherwise it
walks you through the commands for whatever your instance runs on, each one a
click to copy, and tells you when the new version is live.

Those commands, on a VPS:

```bash
docker compose pull && docker compose up -d
```

And on Cloudflare, in the folder you deployed from (a fresh clone works too,
as long as `cf` is signed in to the same account):

```bash
git pull && bun install && bun run deploy
```

Migrations apply themselves — at boot on a VPS (`bun dist/server/main.js
--migrate-only` runs them ahead of a swap if you would rather have the schema
settled first), and on the first request on Cloudflare — and your logged
history is never touched by either.

## One-click updates (Cloudflare)

The update notice on its own is just a notice — but a Cloudflare deployment can
be set up so that **Update** in Settings installs the new release for you, by
dispatching the repository's `deploy` workflow on GitHub Actions. The instance
keeps serving while Actions builds the tag, applies migrations and replaces the
worker from outside; nothing tries to redeploy itself from within. (Migrations
also apply themselves at the new worker's first request, so even a plain
`bun run deploy` needs no separate migrate step.)

Every installation is independent, so the moving parts are arranged for the
fork model: your fork holds nothing but the workflow and your two Cloudflare
secrets, while the deploy checks the code out of the release repo at the tag
being installed — a fork never needs its tags synced, and the Worker config
carries no per-account state. The workflow deploys with `cf` when the tag has a
`cloudflare.config.ts`, and with wrangler for older tags
([cloudflare-cli.md](./cloudflare-cli.md)). The workflow sets `UPDATE_REPO` itself, to
the repository it runs in, so the app dispatches your fork's workflow next time.

Setting it up takes about ten minutes, once. The
[deploy skill](../skills/evbook-deploy/SKILL.md) walks a coding agent through
these same steps with you. `you/evbook` below is your fork.

1. **Fork [the repository](https://github.com/evbook/evbook/fork)**, then open
   the fork's **Actions** tab and enable its workflows — a fresh fork has them
   switched off.
2. **Give the fork your Cloudflare account.** Create an API token at
   <https://dash.cloudflare.com/profile/api-tokens> (Create Token → Custom
   token) with the account permissions Workers Scripts: Edit, D1: Edit and
   Workers R2 Storage: Edit — the deploy asks R2 whether it is enabled, even
   when it is not — limited to your account. Add it and your account ID as
   Actions secrets:

   ```bash
   gh secret set CLOUDFLARE_API_TOKEN --repo you/evbook    # asks for the value without showing it
   gh secret set CLOUDFLARE_ACCOUNT_ID --repo you/evbook   # `bunx cf auth whoami` prints it
   ```

   Without the GitHub CLI, the same two go in under the fork's Settings →
   Secrets and variables → Actions.
3. **Give the Worker a token allowed to start that workflow:**

   ```bash
   bun run setup --github-token
   ```

   It asks which repository deploys this instance, prints a link that opens
   GitHub's token form already filled in (a fine-grained token: choose "Only
   select repositories" and pick your fork; Actions: Read and write), takes the
   token without showing it, tries it against the fork, and only then deploys
   with it. The token is kept as a Worker secret, `UPDATE_GITHUB_TOKEN`, and
   the fork's name in this checkout's git config (`evbook.updateRepo`).
4. **Run the workflow once**, with the newest release tag. It proves the two
   Cloudflare secrets, and leaves the Worker on that release with `UPDATE_REPO`
   pointing at your fork:

   ```bash
   gh workflow run deploy.yml --repo you/evbook -f tag="$(gh release view --repo evbook/evbook --json tagName --jq .tagName)"
   gh run list --repo you/evbook --workflow deploy.yml --limit 1
   ```

Settings → Version then reads "Updates: One click, from here", and the next
release's **Update** asks once and installs it.

Two things to know afterwards:

- **The GitHub token expires** when you told GitHub it should. **Update** then
  reports GitHub's refusal; repeat step 3 with a new token.
- **Deploying from your terminal still works.** Every deploy sets
  `UPDATE_REPO` afresh, and `bun run deploy` takes it from the checkout's git
  config, where step 3 recorded your fork. A fresh clone has no such record:
  run `git config evbook.updateRepo you/evbook` in it first (and
  `bun run deploy:wrangler` never reads it — pass
  `-- --var UPDATE_REPO:you/evbook`). If the setting does get cleared,
  **Update** says so, and running the fork's workflow once (step 4) puts it
  back.

- **To turn it off**, delete the token on GitHub and take it off the Worker:
  `bunx cf workers secrets delete UPDATE_GITHUB_TOKEN --worker evbook`.

Without the token everything stays as it was: the app tells you about the
release and **Update** walks you through the commands. (The *check* for new releases
needs no token — though keeping one set is still kinder to GitHub's shared
rate limits for Workers.)

## How the notice works

Every ten minutes the cron reaches the update check, which asks GitHub for the
repository's tags at most once a day (**Check now** in Settings asks
immediately) — one request from the server, not from your browser, so no
visitor's address reaches GitHub and one instance asks once however many phones
are pointed at it. It is anonymous unless `UPDATE_GITHUB_TOKEN` is set. A
newer version than the running build puts a dismissible notice in the corner; "×" silences that
version for a week, and a version newer still gets to speak up once. A check
that finds a new release makes one more request, for the date of the commit it
was tagged on, which Settings shows beside the version.
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
bun pm version minor --no-git-tag-version   # package.json, package-lock.json and shared/version.ts
git commit -am "release: 0.2.0"
git tag v0.2.0-stable
git push && git push origin v0.2.0-stable
gh release create v0.2.0-stable --verify-tag --title "EVBook 0.2.0" --notes-file notes.md --latest
```

Every tag gets a GitHub release with notes. Keep them short and written for
people running EVBook, not for contributors:

- `### New`, `### Fixed`, `### Changes` and `### Upgrading` sections, each
  only when it has something in it.
- One bullet per user-visible change. Start with a bold phrase, then say in a
  sentence or two what it does for the owner. Work from the PRs merged since
  the previous tag (`git log --oneline <previous tag>..HEAD`).
- Leave out changes that only touch tests, tooling, CI or docs, unless they
  change how people install, deploy or update.
- Under **Upgrading**, list the new migrations (they apply on the first
  request), any manual step, and anything that can't be undone, such as a
  release you can't roll back from.

Pushing the tag also publishes the Docker image (`release-image` workflow):
`ghcr.io/evbook/evbook:<version>` for amd64 and arm64, and `:latest` for a
stable release.

Settings shows a date beside each version and, on hover, the short git
revision. For the installed build both are stamped into the app when it is
built (`vite.config.ts` asks git; the Docker image, built without `.git`, is
told through the `BUILD_REVISION` and `BUILD_COMMITTED_AT` build args, which
the `release-image` workflow passes). A build with neither shows the version
alone.

[`shared/version.ts`](../shared/version.ts) carries the version the build
reports; [`scripts/sync-version.mjs`](../scripts/sync-version.mjs) runs from
the `version` lifecycle script to keep it level with package.json, and a test fails
if the two ever disagree. A tag with no channel suffix is ignored by every
instance, so tagging for anything other than a release is harmless.
