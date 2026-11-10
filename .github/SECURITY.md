# Security policy

EVBook holds the keys to a car: an instance stores Tesla tokens (encrypted at
rest with `ENCRYPTION_KEY`) and a history of where the car has been. Reports of
anything that could expose either are taken seriously and handled privately.

## Reporting a vulnerability

**Please do not open a public issue.** Report it through GitHub's private
vulnerability reporting:

**[Report a vulnerability](https://github.com/evbook/evbook/security/advisories/new)**

Say what you found, which version and hosting it affects (Cloudflare, Docker or
plain Node), and how to reproduce it. A proof of concept against your own
instance or the local demo (`bun run demo`) is ideal. Please do not test
against [demo.evbook.app](https://demo.evbook.app) in a way that disrupts it
for others, and never against somebody else's instance.

You can expect an acknowledgement within a few days. Once a fix is released the
advisory is published, with credit to you unless you would rather not be named.

## Supported versions

Only the latest release is supported. Fixes ship as a new release, which every
instance is told about by its own update check
([docs/updating.md](../docs/updating.md)).

## Scope

In scope:

- the app — the Worker and the Node runtime, the JSON API and the web client,
- the [Token Helper](../extension/) browser extension,
- the telemetry collector at `telemetry.evbook.app`,
- the published container image, `ghcr.io/evbook/evbook`.

Out of scope: a deployment's own configuration (a weak `APP_PASSWORD`, an
instance exposed without TLS), and vulnerabilities in Tesla's, Cloudflare's or
other third parties' services — report those to their owners.

## If you run an instance

Never paste a Tesla token, `ENCRYPTION_KEY` or `APP_PASSWORD` into an issue, a
pull request or a chat. If one has leaked, rotate it: `bun run setup --password`
changes the app password, and signing in to Tesla again replaces the tokens.
