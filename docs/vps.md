# Run on a VPS

The same app runs as one Node process against one SQLite file — no Cloudflare
account involved. The hosting-specific layer lives in
[`src/platform/`](../src/platform/) (`cloudflare/` and `node/` are the two
implementations); everything else is shared, and `bun run test` exercises both.

## With Docker

Any machine that runs a container:

```bash
cp .env.example .env    # set APP_PASSWORD and ENCRYPTION_KEY
docker compose up -d    # serves on :3000
```

The compose file runs the published image
(`ghcr.io/evbook/evbook`, amd64 + arm64, pushed by CI for every release
tag), so updating when the app says a release is out is:

```bash
docker compose pull && docker compose up -d
```

— or run [Watchtower](https://containrrr.dev/watchtower/) and it happens by
itself. To build from source instead, swap the `image:` line for `build: .` in
[`docker-compose.yml`](../docker-compose.yml).

The compose file keeps everything on one named volume mounted at `/data`: the
database at `/data/evbook.sqlite` and uploaded documents under `/data/blobs`.
Backing up is copying that volume. Migrations apply automatically at boot, and
the bookkeeping is wrangler-compatible, so a database exported from D1
(`wrangler d1 export`) can be dropped in and picked up where it left off — and
vice versa.

## Without Docker

Bun 1.4 is what the image runs. The server bundle is built with `--target=node`
and needs nothing but `node:` built-ins, so Node 22.13 or newer (the unflagged
`node:sqlite`) runs the same `dist/server/main.js`.

```bash
bun install
cp .env.example .env
bun run dev:node        # builds the SPA, runs the server from source, listens on :3000
bun run build:server    # dist/server/main.js, for a supervisor to run
```

That leaves `dist/` holding everything a host needs: run
`bun dist/server/main.js` (Bun reads `.env` itself) or
`node --env-file=.env dist/server/main.js` from the checkout under whatever
supervisor you like (systemd, PM2). `PORT`, `DATABASE_PATH` (default
`./data/evbook.sqlite`) and `BLOBS_DIR` (default `./data/blobs`) are the
settings that matter; [`.env.example`](../.env.example) lists the rest.

## In front of it

Put a TLS-terminating reverse proxy (Caddy, nginx) in front for real use: the
session cookie is `Secure`, so plain HTTP logins are dropped by browsers. The
server listens on every interface unless `HOST` says otherwise (`HOST=127.0.0.1`
behind a proxy on the same machine). Proxies must forward the original `Host`
header, and `DEV_AUTOLOGIN` must stay unset — it trusts any request whose host
is `localhost`.

A killed process is safe — polling deadlines, token-refresh clocks and half-done
imports live in the database and resume at the next boot.

The public demo at [demo.evbook.app](https://demo.evbook.app) runs this runtime
with `DEMO=true`; its deployment scripts are in [`deploy/vps/`](../deploy/vps/).
