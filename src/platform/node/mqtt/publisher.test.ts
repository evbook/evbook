import { afterEach, describe, expect, it } from "bun:test";
import type { CarSummaryDto } from "@shared/api-types";
import { FULL_SUMMARY } from "../../../../test/mqtt-summary";
import type { Connect, MqttConnectOptions, MqttConnection } from "./client";
import { startMqttPublisher, type MqttConfig, type MqttControl } from "./publisher";

/** A broker connection that records what is published and connects when told to. */
class FakeConnection implements MqttConnection {
  connected = false;
  published: [string, string][] = [];
  ended = false;
  private connectListeners: (() => void)[] = [];
  private errorListeners: ((message: string) => void)[] = [];
  private closeListeners: (() => void)[] = [];

  constructor(readonly options: MqttConnectOptions) {}

  async publish(topic: string, payload: string) {
    if (!this.connected) throw new Error("not connected");
    this.published.push([topic, payload]);
  }
  onConnect(listener: () => void) {
    this.connectListeners.push(listener);
  }
  onError(listener: (message: string) => void) {
    this.errorListeners.push(listener);
  }
  onClose(listener: () => void) {
    this.closeListeners.push(listener);
  }
  async end() {
    this.ended = true;
    this.connected = false;
  }

  /** The broker accepts: listeners run, as mqtt.js runs them after the online status. */
  up() {
    this.connected = true;
    for (const listener of this.connectListeners) listener();
  }
  down(message = "connect ECONNREFUSED") {
    this.connected = false;
    for (const listener of this.errorListeners) listener(message);
    for (const listener of this.closeListeners) listener();
  }
  topics() {
    return new Map(this.published);
  }
}

const ON: MqttConfig = {
  enabled: true,
  url: "mqtt://broker:1883",
  username: "evbook",
  password: "secret",
  prefix: "evbook",
};

let control: MqttControl | null = null;
afterEach(async () => {
  await control?.stop();
  control = null;
});

function setup(initial: MqttConfig = ON) {
  let config: MqttConfig | Error = initial;
  let summary: CarSummaryDto = { ...FULL_SUMMARY };
  let geofence: string | null = "Home";
  const connections: FakeConnection[] = [];
  const connect: Connect = (options) => {
    const connection = new FakeConnection(options);
    connections.push(connection);
    return connection;
  };
  control = startMqttPublisher({
    config: async () => {
      if (config instanceof Error) throw config;
      return config;
    },
    source: { cars: async () => [{ id: 1, summary, extras: { displayName: "Eve", geofence } }] },
    connect,
    intervalMs: 60_000,
  });
  return {
    control,
    connections,
    setConfig: (next: MqttConfig | Error) => (config = next),
    setSummary: (next: Partial<CarSummaryDto>) => (summary = { ...summary, ...next }),
    setGeofence: (next: string | null) => (geofence = next),
    last: () => connections.at(-1)!,
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("the MQTT publisher", () => {
  it("stays off, and connects to nothing, until it is turned on", async () => {
    const t = setup({ ...ON, enabled: false });
    await settle();
    expect(t.connections).toHaveLength(0);
    expect(t.control.status().state).toBe("off");
  });

  it("connects with the settings and a status topic below the prefix", async () => {
    const t = setup({ ...ON, prefix: "home/cars" });
    await settle();
    expect(t.last().options).toEqual({
      url: "mqtt://broker:1883",
      username: "evbook",
      password: "secret",
      statusTopic: "home/cars/status",
    });
    expect(t.control.status().state).toBe("connecting");
  });

  it("publishes every topic once connected, below <prefix>/cars/<id>/", async () => {
    const t = setup();
    await settle();
    t.last().up();
    await settle();
    const topics = t.last().topics();
    expect(topics.get("evbook/cars/1/battery_level_pct")).toBe("57");
    expect(topics.get("evbook/cars/1/geofence")).toBe("Home");
    expect(topics.get("evbook/cars/1/display_name")).toBe("Eve");
    expect(t.control.status()).toMatchObject({ state: "connected", error: null });
    expect(t.control.status().lastPublishAt).not.toBeNull();
  });

  it("sends only what changed on the next pass", async () => {
    const t = setup();
    await settle();
    t.last().up();
    await settle();
    const before = t.last().published.length;

    t.setSummary({ batteryLevel: 58 });
    t.setGeofence(null);
    await t.control.reload();
    expect(t.last().published.slice(before)).toEqual([
      ["evbook/cars/1/geofence", ""],
      ["evbook/cars/1/battery_level_pct", "58"],
    ]);

    await t.control.reload();
    expect(t.last().published.length).toBe(before + 2);
  });

  it("sends everything again after a reconnect", async () => {
    const t = setup();
    await settle();
    t.last().up();
    await settle();
    const full = t.last().published.length;

    t.last().down();
    expect(t.control.status()).toMatchObject({ state: "error", error: "connect ECONNREFUSED" });
    t.last().up();
    await settle();
    expect(t.last().published.length).toBe(2 * full);
    expect(t.control.status()).toMatchObject({ state: "connected", error: null });
  });

  it("reconnects when the broker, login or prefix changes, and disconnects when turned off", async () => {
    const t = setup();
    await settle();
    t.last().up();
    await settle();

    t.setConfig({ ...ON, prefix: "home/cars" });
    await t.control.reload();
    expect(t.connections).toHaveLength(2);
    expect(t.connections[0]?.ended).toBe(true);
    t.last().up();
    await settle();
    expect(t.last().topics().get("home/cars/cars/1/battery_level_pct")).toBe("57");

    t.setConfig({ ...ON, prefix: "home/cars", enabled: false });
    await t.control.reload();
    expect(t.last().ended).toBe(true);
    expect(t.control.status().state).toBe("off");
  });

  it("says why when the settings cannot be read", async () => {
    const t = setup();
    await settle();
    t.setConfig(new Error("The stored MQTT password cannot be read"));
    await t.control.reload();
    expect(t.control.status()).toMatchObject({ state: "error", error: "The stored MQTT password cannot be read" });
  });
});
