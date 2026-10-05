import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { AppEnv } from "../env";
import type { ActorStorage } from "../ports";
import { createNodeActors, type ActorFactory, type NodeActors } from "./actors";

/**
 * The runtime's plumbing under probes: storage round-trips, alarm persistence
 * and crash semantics, and the per-actor mutex. The real actor classes are
 * covered by the workers suite through the Durable Object shells; here they
 * are swapped for probes so the runtime itself is the thing on trial.
 */

function world(createActor?: ActorFactory) {
  const sqlite = new DatabaseSync(":memory:");
  const env = {} as AppEnv; // probes never touch it
  const actors = createNodeActors(sqlite, env, { createActor });
  return { sqlite, actors };
}

/** A probe on the import key: `status` is in the wrapped method list. */
interface Probe {
  storage: ActorStorage;
  alarms: number[];
  calls: (() => Promise<unknown>)[];
}

function probeWorld() {
  const probe: Probe = { storage: undefined as never, alarms: [], calls: [] };
  const behavior = {
    alarm: async () => {
      probe.alarms.push(Date.now());
      const next = probe.calls.shift();
      if (next) await next();
    },
    status: async () => {
      const next = probe.calls.shift();
      return next ? next() : null;
    },
  };
  const { sqlite, actors } = world((key, storage) => {
    if (key === "import:default") probe.storage = storage;
    return behavior;
  });
  return { sqlite, actors, probe };
}

async function until(check: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition never came true");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("storage", () => {
  it("round-trips JSON values and Uint8Array values by kind", async () => {
    const { actors, probe } = probeWorld();
    void actors.importer(); // instantiates the probe
    const storage = probe.storage;

    await storage.put("job", { id: "a", nested: { n: 1.5, ok: true }, none: null });
    expect(await storage.get("job")).toEqual({ id: "a", nested: { n: 1.5, ok: true }, none: null });

    const bytes = new Uint8Array([0, 1, 2, 255, 128]);
    await storage.put("bytes:0", bytes);
    expect(await storage.get("bytes:0")).toEqual(bytes);
    expect((await storage.get("bytes:0")) instanceof Uint8Array).toBe(true);
  });

  it("bulk put writes every entry; bulk delete answers the removed count", async () => {
    const { actors, probe } = probeWorld();
    void actors.importer();
    const storage = probe.storage;

    await storage.put({ "bytes:0": new Uint8Array([1]), "bytes:1": new Uint8Array([2]), size: 2 });
    expect(await storage.get("size")).toBe(2);
    expect(await storage.delete(["bytes:0", "bytes:1", "bytes:9"])).toBe(2);
    expect(await storage.delete("size")).toBe(true);
    expect(await storage.delete("size")).toBe(false);
  });

  it("lists by prefix in key order, and deleteAll spares the alarm", async () => {
    const { actors, probe } = probeWorld();
    void actors.importer();
    const storage = probe.storage;

    await storage.put({ "bytes:0": new Uint8Array([1]), "bytes:1": new Uint8Array([2]), job: { a: 1 } });
    const listed = await storage.list({ prefix: "bytes:" });
    expect([...listed.keys()]).toEqual(["bytes:0", "bytes:1"]);

    const at = Date.now() + 60_000;
    await storage.setAlarm(at);
    await storage.deleteAll();
    expect(await storage.get("job")).toBeUndefined();
    expect(await storage.getAlarm()).toBe(at); // Cloudflare parity
    await storage.deleteAlarm();
    expect(await storage.getAlarm()).toBeNull();
  });
});

describe("alarms", () => {
  it("fires a due alarm once and consumes the row afterwards", async () => {
    const { sqlite, actors, probe } = probeWorld();
    void actors.importer();
    await probe.storage.setAlarm(Date.now() + 20);
    await until(() => probe.alarms.length === 1);
    // Consumed on completion, so nothing re-fires and nothing is left to recover.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(probe.alarms.length).toBe(1);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM actor_alarms").get()).toEqual({ n: 0 });
  });

  it("keeps the row while the handler runs, so a crash there is recoverable", async () => {
    const { sqlite, actors, probe } = probeWorld();
    void actors.importer();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    probe.calls.push(() => gate); // the handler hangs until released
    await probe.storage.setAlarm(Date.now() + 10);
    await until(() => probe.alarms.length === 1);
    // Mid-handler: the row must still be there — this is the crash story.
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM actor_alarms").get()).toEqual({ n: 1 });
    release();
    await until(() => (sqlite.prepare("SELECT COUNT(*) AS n FROM actor_alarms").get() as { n: number }).n === 0);
  });

  it("a persisted alarm survives a runtime restart and fires on recovery", async () => {
    const sqlite = new DatabaseSync(":memory:");
    const fired: string[] = [];
    const make = (): NodeActors =>
      createNodeActors(sqlite, {} as AppEnv, {
        createActor: (key, storage) => ({
          alarm: async () => {
            fired.push(key);
          },
          // Arm and abandon: the "process" dies before the alarm is due.
          begin: async () => storage.setAlarm(Date.now() + 30),
        }),
      });

    const first = make();
    await (first.importer() as unknown as { begin(label: string): Promise<void> }).begin("x");
    await first.shutdown(); // clears timers, leaves the row — like a dead process

    const second = make();
    second.recoverAlarms();
    await until(() => fired.length === 1);
    expect(fired).toEqual(["import:default"]);
  });

  it("re-arms a retry when the handler throws without rescheduling", async () => {
    const { sqlite, actors, probe } = probeWorld();
    void actors.importer();
    probe.calls.push(() => Promise.reject(new Error("boom")));
    await probe.storage.setAlarm(Date.now() + 10);
    await until(() => probe.alarms.length === 1);
    // The row survives the throw so the retry (or a restart) can run it again.
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM actor_alarms").get()).toEqual({ n: 1 });
  });
});

describe("mutex", () => {
  it("serializes handle calls and alarms per actor", async () => {
    const { actors, probe } = probeWorld();
    const importer = actors.importer() as unknown as { status(): Promise<unknown> };

    let inside = 0;
    let overlapped = false;
    const slow = () =>
      new Promise((resolve) => {
        inside++;
        if (inside > 1) overlapped = true;
        setTimeout(() => {
          inside--;
          resolve(inside);
        }, 30);
      });
    probe.calls.push(slow, slow, slow);

    await probe.storage.setAlarm(Date.now() + 5); // competes with the calls below
    await Promise.all([importer.status(), importer.status()]);
    await until(() => probe.alarms.length === 1);
    expect(overlapped).toBe(false);
  });

  it("a rejected call does not wedge the chain", async () => {
    const { actors, probe } = probeWorld();
    const importer = actors.importer() as unknown as { status(): Promise<unknown> };
    probe.calls.push(() => Promise.reject(new Error("bad")));
    probe.calls.push(async () => "fine");
    await expect(importer.status()).rejects.toThrow("bad");
    await expect(importer.status()).resolves.toBe("fine");
  });
});
