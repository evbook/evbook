import { afterEach, describe, expect, it } from "bun:test";
import { startBroker, type Broker } from "../../../../test/mqtt-broker";
import { connectMqtt, type MqttConnection } from "./client";

/** mqtt.js against a broker on a real socket: login, status, retained publishes, last will. */

let broker: Broker | null = null;
let connection: MqttConnection | null = null;
afterEach(async () => {
  await connection?.end().catch(() => undefined);
  await broker?.close();
  broker = null;
  connection = null;
});

async function until(check: () => boolean, ms = 3_000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function connect(b: Broker) {
  return connectMqtt({ url: b.url, username: "evbook", password: "secret", statusTopic: "evbook/status" });
}

describe("the MQTT connection", () => {
  it("logs in, leaves a last will and says online", async () => {
    broker = await startBroker();
    connection = connect(broker);
    let connects = 0;
    connection.onConnect(() => connects++);
    await until(() => connects === 1);

    expect(broker.connects[0]).toMatchObject({
      username: "evbook",
      password: "secret",
      will: { topic: "evbook/status", payload: "offline" },
    });
    expect(broker.retained.get("evbook/status")).toBe("online");
  });

  it("publishes retained, and refuses while disconnected instead of queueing", async () => {
    broker = await startBroker();
    connection = connect(broker);
    await expect(connection.publish("evbook/cars/1/locked", "true")).rejects.toThrow("not connected");
    await until(() => connection!.connected);
    await connection.publish("evbook/cars/1/locked", "true");
    expect(broker.retained.get("evbook/cars/1/locked")).toBe("true");
  });

  it("says offline on a clean stop", async () => {
    broker = await startBroker();
    connection = connect(broker);
    await until(() => connection!.connected);
    await connection.end();
    expect(broker.retained.get("evbook/status")).toBe("offline");
  });

  it("keeps trying after the broker refused the login, as it does once the user exists", async () => {
    broker = await startBroker();
    broker.refuse = 1;
    connection = connectMqtt({
      url: broker.url,
      username: "evbook",
      password: "secret",
      statusTopic: "evbook/status",
      reconnectMs: 50,
    });
    const errors: string[] = [];
    connection.onError((message) => errors.push(message));
    await until(() => connection!.connected);
    expect(errors).toEqual(["Connection refused: Not authorized"]);
    expect(broker.retained.get("evbook/status")).toBe("online");
  });

  it("reports the failure and reconnects when the broker drops it", async () => {
    broker = await startBroker();
    connection = connect(broker);
    let closes = 0;
    connection.onClose(() => closes++);
    await until(() => connection!.connected);
    broker.dropClients();
    await until(() => closes === 1);
    expect(connection.connected).toBe(false);
  });
});
