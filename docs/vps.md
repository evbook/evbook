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

Set `TRUST_PROXY=true` when exactly one such proxy sits in front and it adds
the client's address to `X-Forwarded-For` (nginx with
`proxy_add_x_forwarded_for`, Caddy and Traefik by default). Repeated wrong
passwords then lock out the address they came from, for a minute and doubling
up to an hour. EVBook reads the last entry of the header, the one the proxy
wrote; the ones before it are whatever the client sent. Without the setting the
server cannot tell clients apart, so it locks nobody out and only makes every
sign-in wait, up to eight seconds, once wrong passwords pile up.

The header is only believed on a connection from a local address (loopback, a
private network, a Docker bridge), where a proxy on the same machine or network
connects from. A request that reaches the server's port straight from the
internet — `docker-compose.yml` publishes it on every interface, and Docker
bypasses ufw — is only slowed down, never locked, whatever it claims. Binding
the port to the proxy alone (`127.0.0.1:3000:3000`, or `HOST=127.0.0.1`) is
still the better setup.

Cloudflare's proxy (the orange cloud) or a Cloudflare Tunnel in front of your
proxy counts as a second proxy: the last entry is then a Cloudflare or
loopback address shared by everyone. A loopback or private last entry is never
locked, but a Cloudflare edge address would be, and with it everyone behind
that edge. Leave `TRUST_PROXY` unset in that setup.

Only this runtime can publish each car's values to an MQTT broker, because it
keeps a connection open; turn it on in Settings ([mqtt.md](./mqtt.md)).

A killed process is safe — polling deadlines, token-refresh clocks and half-done
imports live in the database and resume at the next boot.

The public demo at [demo.evbook.app](https://demo.evbook.app) runs this runtime
with `DEMO=true`.
