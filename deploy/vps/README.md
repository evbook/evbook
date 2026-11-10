# demo.evbook.app and evbook.app on a VPS

How the project hosts its own public demo and landing page — a worked example
of a CI-to-VPS deploy, not an install path.

The public showcase, which is deliberately *not* how anybody runs EVBook for
real: the app runs in `DEMO=true` against a generated fixture world, so there
is no Tesla account, no password and nothing to protect. The real install
paths are [Cloudflare](../../README.md) and [Docker](../../docs/vps.md).

Two things are served:

| Host | What | How |
|---|---|---|
| `demo.evbook.app` | The whole app, demo mode | Node under PM2 on `127.0.0.1:3100`, proxied by Caddy |
| `evbook.app`, `www.evbook.app` | The landing page in [`site/`](../../site/) | Caddy `file_server`, no process |

Both are put there by [`.github/workflows/deploy-demo.yml`](../../.github/workflows/deploy-demo.yml),
which builds in CI and ships the result over SSH. Nothing is built on the VPS.

## Layout on the box

```
/srv/evbook/
  releases/<sha>/      one build: dist/, migrations/, demo/, e2e/mocks/, site/
  current -> releases/<sha>        the release PM2 runs and Caddy serves
  data/                the fixture database and its WAL (survives releases)
  reseed.sh            rebuilds the fixture world, installed from this directory
```

Releases are kept (the last five) and `current` is a symlink, so a rollback is
repointing it and `pm2 restart evbook-demo`.

## Why it looks like this

- **PM2, not Docker or systemd.** The box already runs PM2 with `pm2 startup`
  wired up, so one more app is the change that surprises nobody.
  [`ecosystem.config.cjs`](./ecosystem.config.cjs) lives *inside the release*
  rather than in any shared ecosystem file — the box may host other apps, so
  EVBook never edits their config and can be added or removed on its own.
- **Unprivileged.** PM2 runs as root here, but the app process drops to the
  `evbook` user via the ecosystem file's `uid`/`gid`. A public demo should not
  be root.
- **`DISABLE_CRON=true`.** The fixture world is already geocoded, so the minute
  clock has nothing to do but make outbound Nominatim and elevation calls on
  behalf of a public demo. Off.
- **HTTP-01 for TLS.** These three names resolve to this box, so Caddy's
  default challenge needs no DNS-provider credentials for `evbook.app`. It keeps working with
  Cloudflare in front, which exempts the ACME path from its HTTPS redirect.
- **Cloudflare in front.** All three names are proxied through Cloudflare, and
  Caddy refuses anything that did not come from its edge. That lives in
  [`deploy/cloudflare/`](../cloudflare/) — including the origin lock this
  directory's `bootstrap.sh` seeds as an empty, inert include.
- **Caddy import, not an edit.** [`caddy/evbook.caddyfile`](./caddy/evbook.caddyfile)
  is dropped into `/etc/caddy/sites/` and pulled in by a single `import` line
  appended to the main Caddyfile. The box may host other sites, so redeploying
  EVBook never rewrites their configuration.

## First-time setup

Run once, from a checkout, against a box that already has Caddy, Node 22+ and
PM2:

```bash
./deploy/vps/bootstrap.sh root@<vps-host>
```

It creates the user and directories, installs the reseed timer, adds the Caddy
snippet and the one `import` line, and reloads Caddy. It is idempotent.

If the box's Caddy is a custom build (the shared Caddyfile there needs a DNS
provider module), also run:

```bash
./deploy/vps/caddy-guard.sh root@<vps-host>
```

The caddy `.deb` ships the stock binary, so a package upgrade drops custom
modules. The old process keeps serving until the next restart, and then
every site on the box goes down; that caused the 2026-10-29 outage.
`caddy-guard.sh` puts the package on hold and installs an apt hook that adds
the modules back after any upgrade. To upgrade on purpose, run
`apt-mark unhold caddy && apt-get install caddy && apt-mark hold caddy`.

## Deploying

Normally: push to `main`, or run the **deploy-demo** workflow from the Actions
page. By hand from a checkout:

```bash
npm run build:app && npm run build:server
./deploy/vps/release.sh root@<vps-host>
```

## Checking it

```bash
./deploy/vps/verify.sh
```

## Getting the landing page found

`robots.txt` names `sitemap.xml`, which lists the two public pages; the demo
stays out of every index by its `noindex` header. After a release that changes
`site/`, ask the IndexNow engines (Bing, Yandex, Naver, Seznam, Yep) to recrawl:

```bash
./deploy/vps/indexnow.sh
```

It submits every URL in the live sitemap. The key it sends is the
`site/<key>.txt` file — public by design, since serving it is how IndexNow
checks the request came from the site's owner. Google takes no part in
IndexNow: it follows the sitemap, and is nudged by hand with URL Inspection →
Request indexing in Search Console.
