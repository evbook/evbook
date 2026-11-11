# Notes for coding agents

## Releases

Cut releases as described in [docs/updating.md](docs/updating.md#releases-are-tags).
After you push the tag, always publish a GitHub release for it with concise
release notes (`gh release create <tag> --verify-tag --notes-file …`), following
the rules in that section. A tag without a release is not finished. Show the
user the notes before you publish them, unless they have already approved them.
