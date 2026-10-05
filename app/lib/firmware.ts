/** Turning what the car calls its firmware into somewhere to read about it. */

/**
 * Release notes for a firmware version on notateslaapp.com, or undefined when the
 * string does not look like a Tesla version at all.
 *
 * The car reports `car_version` as the release followed by a build hash —
 * "2026.26.1 e3a6ef2ee0b2" — and only the release names a page, so the hash is
 * dropped. Imported rows and very old firmware do not always keep that shape, and a
 * link built out of one of those would be a 404 dressed up as a fact, so anything
 * that is not a year followed by dotted numbers gets no link rather than a guess.
 */
export function releaseNotesUrl(version: string | null | undefined): string | undefined {
  if (!version) return undefined;
  const release = /^\d{4}(?:\.\d+)+/.exec(version.trim())?.[0];
  if (!release) return undefined;
  return `https://www.notateslaapp.com/software-updates/version/${release}/release-notes`;
}
