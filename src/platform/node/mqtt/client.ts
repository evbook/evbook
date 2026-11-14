import mqtt from "mqtt";

/**
 * The broker connection, kept apart from what is published so that a later
 * subscriber (a provider that delivers its data over MQTT) can use the same
 * client: connect with credentials, reconnect on its own, announce the
 * instance as online, and leave a last will that says offline.
 *
 * mqtt.js does the protocol. This wraps the part EVBook relies on behind a
 * small interface, so the publisher can be tested against a fake.
 */

export interface MqttConnectOptions {
  url: string;
  username: string;
  password: string;
  /** `<prefix>/status`: "online" once connected, "offline" by last will or on a clean stop. Retained. */
  statusTopic: string;
  /** Between attempts; 10 s unless a test wants it shorter. */
  reconnectMs?: number;
}

export interface MqttConnection {
  readonly connected: boolean;
  /** Retained, QoS 1. Rejects while disconnected rather than queueing. */
  publish(topic: string, payload: string): Promise<void>;
  /** Fires on every (re)connect, after the status topic says online. */
  onConnect(listener: () => void): void;
  /** Fires when the broker or the network fails; the client keeps retrying. */
  onError(listener: (message: string) => void): void;
  onClose(listener: () => void): void;
  /** Says offline, then disconnects. */
  end(): Promise<void>;
}

export type Connect = (options: MqttConnectOptions) => MqttConnection;

const RECONNECT_MS = 10_000;
const CONNECT_TIMEOUT_MS = 10_000;

export const connectMqtt: Connect = (options) => {
  const client = mqtt.connect(options.url, {
    username: options.username || undefined,
    password: options.password || undefined,
    clientId: `evbook-${Math.random().toString(16).slice(2, 10)}`,
    reconnectPeriod: options.reconnectMs ?? RECONNECT_MS,
    // mqtt.js stops for good when the broker refuses the login. Keep trying:
    // the usual cause is a user added to the broker after EVBook was set up,
    // and nothing in EVBook changes when it is fixed there.
    reconnectOnConnackError: true,
    connectTimeout: CONNECT_TIMEOUT_MS,
    // Nothing queued while offline: the publisher sends everything again on
    // reconnect, and a queue would only grow while the broker is away.
    queueQoSZero: false,
    will: { topic: options.statusTopic, payload: Buffer.from("offline"), qos: 1, retain: true },
  });
  const connectListeners: (() => void)[] = [];

  client.on("connect", () => {
    client
      .publishAsync(options.statusTopic, "online", { qos: 1, retain: true })
      .then(() => {
        for (const listener of connectListeners) listener();
      })
      .catch(() => {
        // The close or error event that follows reports it.
      });
  });

  return {
    get connected() {
      return client.connected;
    },
    async publish(topic, payload) {
      if (!client.connected) throw new Error("not connected");
      await client.publishAsync(topic, payload, { qos: 1, retain: true });
    },
    onConnect(listener) {
      connectListeners.push(listener);
    },
    onError(listener) {
      client.on("error", (error) => listener(error.message));
    },
    onClose(listener) {
      client.on("close", listener);
    },
    async end() {
      if (client.connected) {
        await client.publishAsync(options.statusTopic, "offline", { qos: 1, retain: true }).catch(() => undefined);
      }
      await client.endAsync();
    },
  };
};
