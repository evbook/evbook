# Notes for coding agents

## Releases

Cut releases as described in [docs/updating.md](docs/updating.md#releases-are-tags).
After you push the tag, always publish a GitHub release for it with concise
release notes (`gh release create <tag> --verify-tag --notes-file …`), following
the rules in that section. A tag without a release is not finished. Show the
user the notes before you publish them, unless they have already approved them.

## Adding or changing a provider (a car make)

Read [docs/providers.md](docs/providers.md) before writing any code, and follow
its steps in order. The short version:

- Add the id to `PROVIDERS` in `shared/api-types.ts` first and let
  `bun run typecheck` list what is missing: every registry is keyed by the
  provider.
- A provider is its own files: `src/core/<id>/`, `src/actors/<id>Poll.ts`,
  `src/api/<id>.ts`, `app/components/<Id>Connect.tsx`, `test/fake-<id>.ts`,
  `docs/<id>.md`. Elsewhere it is one line in a registry.
- Never add a `provider === "<id>"` branch to `src/actors/vehicle.ts`,
  `src/api/accounts.ts` or a page. If the `ProviderPoller` or `AccountAdapter`
  interface cannot say what the provider needs, extend the interface for every
  provider.
- Never copy from another provider's files. Charge-energy integration, the
  snapshot fingerprint and the snapshot store are shared
  (`src/core/provider/`, `src/actors/providerPoll.ts`); a helper two providers
  need moves there before the second one uses it.
- Providers are read-only: no function that could send the car a command.
- Build against a fake of the maker's published contract (`test/fake-<id>.ts`).
  Never sign in to a maker's service or call it with real credentials.
- Finish with the "Done means" checklist in docs/providers.md, and say in the
  pull request what is not verified on a real car.
