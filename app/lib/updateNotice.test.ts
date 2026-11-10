import { describe, expect, it } from "bun:test";
import type { VersionInfoDto } from "@shared/api-types";
import { REMIND_AFTER_MS, readDismissal, shouldOfferUpdate, writeDismissal, type DismissalStore } from "./updateNotice";

/** The nagging policy: offer an update, then take no for an answer. */

const NOW = 1_700_000_000_000;

function info(over: Partial<VersionInfoDto> = {}): VersionInfoDto {
  return {
    current: "0.1.0",
    channel: "stable",
    latest: "0.2.0",
    releaseUrl: "https://github.com/evbook/evbook/releases/tag/v0.2.0-stable",
    checkedAt: NOW,
    updateAvailable: true,
    checkDisabled: false,
    canInstall: false,
    ...over,
  };
}

/** localStorage's two methods over a plain object. */
function store(initial?: string): DismissalStore & { value: string | undefined } {
  return {
    value: initial,
    getItem() {
      return this.value ?? null;
    },
    setItem(_key: string, value: string) {
      this.value = value;
    },
  };
}

describe("shouldOfferUpdate", () => {
  it("says nothing while the version is still being fetched", () => {
    expect(shouldOfferUpdate(undefined, null, NOW)).toBe(false);
  });

  it("says nothing when the instance is up to date", () => {
    expect(shouldOfferUpdate(info({ updateAvailable: false }), null, NOW)).toBe(false);
  });

  it("offers an update nobody has waved away", () => {
    expect(shouldOfferUpdate(info(), null, NOW)).toBe(true);
  });

  it("stays quiet for a week after Later", () => {
    const dismissal = { version: "0.2.0", at: NOW };
    expect(shouldOfferUpdate(info(), dismissal, NOW + REMIND_AFTER_MS - 1)).toBe(false);
    expect(shouldOfferUpdate(info(), dismissal, NOW + REMIND_AFTER_MS)).toBe(true);
  });

  it("speaks up again for a version the reader has not been offered", () => {
    // Dismissing 0.2.0 dismissed 0.2.0. 0.3.0 is news.
    expect(shouldOfferUpdate(info({ latest: "0.3.0" }), { version: "0.2.0", at: NOW }, NOW + 1)).toBe(true);
  });
});

describe("the stored dismissal", () => {
  it("round-trips", () => {
    const s = store();
    writeDismissal(s, "0.2.0", NOW);
    expect(readDismissal(s)).toEqual({ version: "0.2.0", at: NOW });
  });

  it("treats a corrupted record as no record", () => {
    expect(readDismissal(store("not json"))).toBeNull();
    expect(readDismissal(store('{"version":"0.2.0"}'))).toBeNull();
    expect(readDismissal(store("null"))).toBeNull();
  });

  it("survives a browser with storage switched off", () => {
    // A private window throws on both calls; the app still has to render.
    const blocked: DismissalStore = {
      getItem() {
        throw new Error("denied");
      },
      setItem() {
        throw new Error("denied");
      },
    };
    expect(readDismissal(blocked)).toBeNull();
    expect(() => writeDismissal(blocked, "0.2.0", NOW)).not.toThrow();
  });
});
