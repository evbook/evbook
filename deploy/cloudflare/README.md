# evbook.app and demo.evbook.app behind Cloudflare

How the project puts its own public demo and landing page behind Cloudflare —
a worked example, not an install path.

The VPS keeps serving both names exactly as [`deploy/vps/`](../vps/) describes —
Caddy, its own Let's Encrypt certificates, the PM2 demo on `127.0.0.1:3100`.
Cloudflare goes *in front* as a proxy. Nothing moves and nothing is rebuilt.

This is unrelated to the Worker in [`wrangler.jsonc`](../../wrangler.jsonc),
which is how somebody installs EVBook for themselves. These three names are the
public showcase and they live on the VPS.

| Host | Behind Cloudflare | Origin |
|---|---|---|
| `evbook.app` | proxied | Caddy `file_server` over `site/` |
| `www.evbook.app` | proxied | Caddy redirect to the apex |
| `demo.evbook.app` | proxied | Caddy → PM2 on `127.0.0.1:3100` |

## Why the wildcard is dropped

The previous DNS zone answered `*.evbook.app`, which is the only reason
`demo.evbook.app` ever resolved — there was never an explicit record for it.
Cloudflare's "Add site" flow imports such a wildcard, proxied, and it *does*
proxy correctly.

It is still dropped, for a different reason: Caddy has a site block for exactly
three names and holds a per-name certificate for each, with no wildcard
certificate. Any other subdomain therefore reaches the edge, gets forwarded, and
fails the origin TLS handshake — which under Full (strict) surfaces as a
Cloudflare 526. An `NXDOMAIN` is a cleaner answer than a confusing error page
for names nothing serves. Nothing in the repository refers to a subdomain
outside those three.

The zone has no MX or CAA records, so there is no mail to break. Any
`_acme-challenge` TXT records that come across are not used — Caddy validates
over HTTP-01 here — and `cutover.sh` leaves them alone rather than tidying them
away.

## Running it

Settings go in `./.env` at the repository root (gitignored) or the
environment; all three scripts read that file. None of them is used by an
ordinary EVBook installation.

| Variable | Used by | What |
|---|---|---|
| `ORIGIN_IP` | all three | The VPS's public IP — what the proxied records point at, and what `verify.sh`/`origin-lock.sh` connect to directly. `origin-lock.sh` can also take it from a `user@<ip>` target. |
| `CLOUDFLARE_API_TOKEN` | `cutover.sh` | See below. |
| `CLOUDFLARE_ACCOUNT_ID` | `cutover.sh` | Optional; only to create the zone with a token that cannot list accounts. |
| `PORKBUN_API_KEY`, `PORKBUN_SECRET_API_KEY` | `cutover.sh` | Optional, and only if your registrar is Porkbun (with API access enabled for the domain): lets the script switch the nameservers itself. |

Wrangler's own OAuth token is `zone:read` only and **cannot** do any of this.
Use a **user-owned** API token (avatar menu » My Profile » API Tokens, at
[dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens))
with Zone:DNS:Edit and Zone:Zone Settings:Edit — an account-owned token cannot
hold those permissions.

| 1st dropdown | 2nd | 3rd | Why |
|---|---|---|---|
| Zone | DNS | Edit | the three A records |
| Zone | Zone Settings | Edit | SSL mode, HSTS, TLS floor |
| Account | Zone | Edit | *only* to create the zone from the API |

Zone Resources: Include » Specific zone » `evbook.app`. If the zone does not
exist yet it cannot be picked by name — use All zones, or just add the domain in
the dashboard first and skip the third row entirely.

```bash
# .env
ORIGIN_IP=<origin-ip>
CLOUDFLARE_API_TOKEN=...
#PORKBUN_API_KEY=...          # optional: automates the nameserver switch
#PORKBUN_SECRET_API_KEY=...
```

Then, in order:

```bash
deploy/cloudflare/cutover.sh --plan   # read this before the real run
deploy/cloudflare/cutover.sh          # zone, records, settings, nameservers
deploy/cloudflare/verify.sh           # poll until it passes
deploy/cloudflare/origin-lock.sh root@<origin-ip>
```

Everything `cutover.sh` does is inert until the nameservers change, and it is
idempotent — re-running after a partial failure converges rather than
duplicating. Switching the nameservers is the one step it only automates for
Porkbun, and only when those optional credentials are set; otherwise it stops
and prints the nameservers to set at your registrar by hand.

## What gets set

- **SSL/TLS mode: Full (strict).** Safe from the first second, because Caddy
  already holds valid certificates for all three names. Anything weaker leaves
  the edge-to-origin hop unauthenticated, which is how a site ends up looking
  encrypted without being it.
- **Always Use HTTPS**, **minimum TLS 1.2**, **Automatic HTTPS Rewrites**, and
  HSTS at the edge to match what the origin already sends.

Certificate renewal keeps working: Cloudflare exempts
`/.well-known/acme-challenge/` from its HTTPS redirect, and Let's Encrypt
follows the redirect regardless.

## The origin lock

`origin-lock.sh` is what makes the origin *only* reachable through Cloudflare —
without it the VPS still answers anyone who connects to `<origin-ip>`
directly with the right `Host`, which bypasses the edge entirely.

It writes `/etc/caddy/sites/evbook-origin-lock.inc`, a file each of EVBook's
three site blocks imports, containing a `remote_ip` matcher built from
Cloudflare's [published ranges](https://www.cloudflare.com/ips-v4) fetched at
run time. Nothing else on the box imports it, so any other sites it hosts are
unaffected.

Two safeguards, both of which exist because the failure mode is an outage:

- It **refuses to run** until all three names resolve to the edge. Locking an
  origin whose DNS still points at it takes the sites down.
- [`bootstrap.sh`](../vps/bootstrap.sh) creates the include *empty* when absent
  and never overwrites a filled-in one. Empty is a valid no-op, so the config is
  correct both before and after the cutover, and a redeploy cannot silently
  reopen the origin.

`origin-lock.sh root@<origin-ip> --off` reverts it.

## Rolling back

Point the nameservers back at your registrar's (or previous DNS provider's),
whose zone still has the original records. Run `origin-lock.sh --off` first, or
the origin will refuse the direct traffic those records send straight to it.
