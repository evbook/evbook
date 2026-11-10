import { describe, expect, it } from "bun:test";
import pkg from "../package.json";
import { APP_VERSION, compareVersions, parseReleaseTag, pickLatestRelease, releaseTagUrl } from "./version";

/**
 * What a release tag means, and the two ways getting it wrong would hurt: an
 * update offered that does not exist, or a real one never offered at all.
 */

describe("APP_VERSION", () => {
  it("is the version package.json carries", () => {
    // The literal exists because five build configs would otherwise each need a
    // define (see version.ts). This is what stops the two from drifting.
    expect(APP_VERSION).toBe(pkg.version);
  });
});

describe("parseReleaseTag", () => {
  it("reads a channel tag, with or without the leading v", () => {
    expect(parseReleaseTag("v1.2.3-stable")).toEqual({ tag: "v1.2.3-stable", version: "1.2.3", channel: "stable" });
    expect(parseReleaseTag("1.2.3-canary")).toEqual({ tag: "1.2.3-canary", version: "1.2.3", channel: "canary" });
  });

  it("refuses a tag with no channel", () => {
    // Not treated as stable: a tag pushed for something other than a release
    // must not become an update offered to every instance.
    expect(parseReleaseTag("v1.2.3")).toBeNull();
  });

  it("refuses a channel nobody publishes", () => {
    expect(parseReleaseTag("v1.2.3-nightly")).toBeNull();
  });

  it("refuses anything that is not a three-part version", () => {
    expect(parseReleaseTag("v1.2-stable")).toBeNull();
    expect(parseReleaseTag("release-stable")).toBeNull();
    expect(parseReleaseTag("")).toBeNull();
  });
});

describe("compareVersions", () => {
  it("orders by each part in turn", () => {
    expect(compareVersions("1.0.0", "0.9.9")).toBeGreaterThan(0);
    expect(compareVersions("0.2.0", "0.10.0")).toBeLessThan(0);
    expect(compareVersions("0.1.2", "0.1.10")).toBeLessThan(0);
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
  });

  it("calls an unreadable version neither newer nor older", () => {
    // The consequence of any other answer is a permanent "update available"
    // banner pointing at a version that cannot be installed.
    expect(compareVersions("garbage", "1.0.0")).toBe(0);
    expect(compareVersions("1.0.0", "garbage")).toBe(0);
  });
});

describe("pickLatestRelease", () => {
  const TAGS = ["v0.1.0-stable", "v0.3.0-canary", "v0.2.0-stable", "v0.10.0-stable", "nightly", "v0.11.0"];

  it("takes the highest version on the channel, not the first tag listed", () => {
    // GitHub does not order its tag listing by version, and 0.10 sorts before
    // 0.2 as text — either would offer an update backwards.
    expect(pickLatestRelease(TAGS, "stable")?.version).toBe("0.10.0");
  });

  it("keeps the channels apart", () => {
    expect(pickLatestRelease(TAGS, "canary")?.version).toBe("0.3.0");
  });

  it("is null when the channel has nothing on it", () => {
    expect(pickLatestRelease(["v1.0.0", "main"], "stable")).toBeNull();
    expect(pickLatestRelease([], "stable")).toBeNull();
  });
});

describe("releaseTagUrl", () => {
  it("points at the tag's own page, which exists with or without a drafted release", () => {
    expect(releaseTagUrl("v1.2.3-stable", "someone/evbook")).toBe(
      "https://github.com/someone/evbook/releases/tag/v1.2.3-stable",
    );
  });
});
