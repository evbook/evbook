/**
 * What this build calls itself, and how it recognises a newer one.
 *
 * A release is a git tag of the form `v<major>.<minor>.<patch>-<channel>`, e.g.
 * `v0.1.0-stable`. The channel suffix is there from the first tag on purpose:
 * adding a canary channel later must not make every already-installed instance
 * start offering its owner a pre-release, and a suffix nobody parses is a
 * suffix that cannot be added afterwards without a flag day.
 *
 * The version is a plain literal rather than something a bundler injects. Three
 * bundlers build this code — vite for the app, Bun for the Node server,
 * wrangler for the worker — and two test runners run it, so a build-time
 * define would be five places to keep in step. `version.test.ts` pins the
 * literal to package.json instead, so `bun pm version` and this file cannot drift.
 */

/** This build. Bump with `bun pm version`, which keeps package.json in step. */
export const APP_VERSION = "0.8.0";

/** Where releases are tagged. A fork changes this and its instances follow it. */
export const RELEASE_REPO = "evbook/evbook";

const RELEASE_CHANNELS = ["stable", "canary"] as const;
export type ReleaseChannel = (typeof RELEASE_CHANNELS)[number];

/** What an instance follows unless it is configured otherwise. */
export const DEFAULT_CHANNEL: ReleaseChannel = "stable";

export function isReleaseChannel(value: string): value is ReleaseChannel {
  return (RELEASE_CHANNELS as readonly string[]).includes(value);
}

export interface ReleaseTag {
  /** The tag exactly as git has it, which is what a URL has to be built from. */
  tag: string;
  /** The dotted version, without the leading `v` or the channel suffix. */
  version: string;
  channel: ReleaseChannel;
}

/** `v0.1.0-stable`, and the same thing without the conventional leading `v`. */
const TAG_PATTERN = /^v?(\d+\.\d+\.\d+)-([a-z]+)$/;

/**
 * A release tag, or null for anything else in the repository's tag list —
 * `v0.1.0` with no channel included. An unsuffixed tag is deliberately not
 * treated as stable: this is what stops a tag that was never meant as a release
 * from being offered to everyone.
 */
export function parseReleaseTag(tag: string): ReleaseTag | null {
  const trimmed = tag.trim();
  const match = TAG_PATTERN.exec(trimmed);
  const version = match?.[1];
  const channel = match?.[2];
  if (!version || !channel || !isReleaseChannel(channel)) return null;
  return { tag: trimmed, version, channel };
}

function parts(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * Negative when `a` is older, positive when it is newer, zero when they match
 * or when either is not a version at all — an unreadable version must never
 * come out as "newer", or a stray tag would announce an update that does not
 * exist.
 */
export function compareVersions(a: string, b: string): number {
  const left = parts(a);
  const right = parts(b);
  if (!left || !right) return 0;
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}

/**
 * The newest release on one channel out of a repository's tags.
 *
 * The tags are compared rather than trusted in the order they arrive: the
 * GitHub tag listing is not ordered by version, and a repository that has ever
 * tagged out of order would otherwise offer an update backwards.
 */
export function pickLatestRelease(tags: readonly string[], channel: ReleaseChannel): ReleaseTag | null {
  let latest: ReleaseTag | null = null;
  for (const tag of tags) {
    const release = parseReleaseTag(tag);
    if (!release || release.channel !== channel) continue;
    if (!latest || compareVersions(release.version, latest.version) > 0) latest = release;
  }
  return latest;
}

/**
 * Where to read about a release. GitHub renders this page for any tag, so it
 * works whether or not a Release was drafted on top of it.
 */
export function releaseTagUrl(tag: string, repo: string = RELEASE_REPO): string {
  return `https://github.com/${repo}/releases/tag/${tag}`;
}
