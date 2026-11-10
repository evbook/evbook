# Contributing to EVBook

Issues and pull requests are welcome — bug reports, fixes, new import adapters,
documentation. This page is the short version; the long ones are
[docs/development.md](../docs/development.md) and
[docs/testing.md](../docs/testing.md).

By taking part you agree to the [Code of Conduct](./CODE_OF_CONDUCT.md).
Security problems go through [SECURITY.md](./SECURITY.md), not the issue tracker.

## Before you start

- **A bug?** Open an issue with what you did, what you expected and what
  happened. The version is in Settings; the hosting (Cloudflare, Docker, plain
  Node) matters more often than it seems.
- **A feature?** Open an issue first if it is more than a small change, so
  nobody builds something that cannot be merged. Larger ideas get a write-up
  under [docs/proposals/](../docs/proposals/).
- **Never paste a secret** — a Tesla token, `ENCRYPTION_KEY`, `APP_PASSWORD` —
  or a VIN into an issue or a pull request. The demo data has none of them, and
  a reproduction against the demo is the most useful kind.

## Setup

[Bun](https://bun.com) 1.4 or newer, and Node 22.18 or newer for wrangler and
`cf` (they do not run on Bun).

```bash
git clone https://github.com/evbook/evbook.git && cd evbook
bun install
bun run demo       # the whole app against two generated cars, on :8787
```

No Tesla account is needed: `bun run demo` serves a generated history, and
[`scripts/fake-tesla.mjs`](../scripts/fake-tesla.mjs) impersonates the Tesla API
for work on the live polling loop. `bun run dev` runs the real Worker locally —
[docs/development.md](../docs/development.md) has the details.

## Before you open a pull request

```bash
bun run test           # layout and config checks, bun test, then the workerd suite
bun run typecheck      # app, worker, Node runtime, e2e and tooling sources
bun run lint           # correctness rules only — nothing about style
bun run format         # bun fmt
```

Pull requests are not built by CI yet, so these four are the check. If the
change alters a screen, also run `bun run e2e` and commit the refreshed
screenshots of the stories it touched — they are the stories' documentation.

## House rules

- **A spec lives next to the module it covers** and is named after it:
  `src/api/drives.ts` → `src/api/drives.test.ts`. A spec that needs workerd
  (D1, Durable Objects, R2) is `*.workerd.test.ts` and runs under Vitest;
  everything else runs under `bun test`. `bun run test` enforces the layout.
- **The app core carries no Cloudflare dependency.** Hosting-specific code
  belongs in `src/platform/` and `src/do/`; `tsconfig.node.json` compiling
  clean is the proof.
- **Schema changes are SQL files** in `migrations/`, followed by
  `bun run generate:migrations`.
- **Two lockfiles.** After adding, removing or upgrading a package, run
  `bun run lock:npm` so `package-lock.json` keeps step with `bun.lock` —
  installations with an older deploy workflow still install with npm.
- **Two Worker configs.** `cloudflare.config.ts` and `wrangler.jsonc` describe
  the same Worker and must agree
  ([docs/cloudflare-cli.md](../docs/cloudflare-cli.md)).
- **Comments say why, not what.** The code base explains its decisions where
  they were made; a change that reverses one should update the comment too.

## Pull requests

Keep one concern to a pull request. Pull requests are squash-merged, so the
title becomes the commit: write it as a sentence about what changes for the
person using the app — "Take the time zone from the browser", not "Update
utils". Say in the description how you tested it.

Contributions are licensed under [Apache-2.0](../LICENSE), like the rest of the
project.
