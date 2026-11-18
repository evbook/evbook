import { describe, expect, it } from "bun:test";
import { CHARGE_STALE_MS, MOTION_STALE_MS, type PleosView } from "../core/pleos/normalize";
import { modeOf, tokenWait } from "./pleosPoll";

const T = 1_800_000_000_000;
const r = <V>(v: V, at = T) => ({ v, at, seen: T });

describe("modeOf", () => {
  it("drives on a fresh 'not in P, ready', charges on an active charge, and is parked otherwise", () => {
    const driving: PleosView = { inPark: r(false), ready: r(true) };
    expect(modeOf(driving, T)).toBe("driving");
    expect(modeOf(driving, T + MOTION_STALE_MS + 1)).toBe("parked");
    const charging: PleosView = { plug: r("connected" as const), activity: r("active" as const) };
    expect(modeOf(charging, T)).toBe("charging");
    expect(modeOf(charging, T + CHARGE_STALE_MS + 1)).toBe("parked");
    expect(modeOf({}, T)).toBe("parked");
  });
});

describe("tokenWait", () => {
  it("stops for an hour on a key the owner has to replace, and waits as told otherwise", () => {
    expect(tokenWait({ ok: false, kind: "key_refused" })).toEqual({ kind: "key_refused", waitMs: 3_600_000 });
    expect(tokenWait({ ok: false, kind: "no_key" }).waitMs).toBe(3_600_000);
    expect(tokenWait({ ok: false, kind: "key_shared", retryInMs: 600_000 })).toEqual({
      kind: "key_shared",
      waitMs: 600_000,
    });
    expect(tokenWait({ ok: false, kind: "rate_limited", retryInMs: 900_000 }).waitMs).toBe(900_000);
    expect(tokenWait({ ok: false, kind: "unavailable" }).waitMs).toBe(600_000);
  });
});
