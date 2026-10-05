import { describe, expect, it } from "vitest";
import { releaseNotesUrl } from "./firmware";

/**
 * The link is built out of a string the car hands over, and the only failure that
 * matters is a confident URL to a page that does not exist. So the cases are the
 * shapes `car_version` actually arrives in, and everything else getting no link.
 */

describe("releaseNotesUrl", () => {
  it("uses the release and drops the build hash", () => {
    expect(releaseNotesUrl("2026.26.1 e3a6ef2ee0b2")).toBe(
      "https://www.notateslaapp.com/software-updates/version/2026.26.1/release-notes",
    );
  });

  it("keeps a four-part release whole", () => {
    // Point releases on an old branch go a level deeper, and truncating to three
    // would link to a version this car never ran.
    expect(releaseNotesUrl("2023.44.30.8 c1f9a2b")).toContain("/version/2023.44.30.8/");
  });

  it("handles a version with no hash after it", () => {
    expect(releaseNotesUrl("2025.14.12")).toContain("/version/2025.14.12/");
  });

  it("has no link for a version it cannot recognise", () => {
    expect(releaseNotesUrl(null)).toBeUndefined();
    expect(releaseNotesUrl(undefined)).toBeUndefined();
    expect(releaseNotesUrl("")).toBeUndefined();
    expect(releaseNotesUrl("unknown")).toBeUndefined();
    // A bare year is not a release, and neither is a hash on its own.
    expect(releaseNotesUrl("2026")).toBeUndefined();
    expect(releaseNotesUrl("e3a6ef2ee0b2")).toBeUndefined();
  });
});
