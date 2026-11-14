import { createServer, type Server, type Socket } from "node:net";
import mqttPacket from "mqtt-packet";

/**
 * Just enough of an MQTT 3.1.1 broker for the tests: accepts every
 * connection, acknowledges QoS 1 publishes, keeps retained messages, and
 * delivers a client's last will when its socket drops without a DISCONNECT.
 * It records connects and publishes; it does not route to subscribers.
 */
export interface Broker {
  url: string;
  connects: { clientId: string; username?: string; password?: string; will?: { topic: string; payload: string } }[];
  /** Topic → payload, as a retaining broker would hold them. */
  retained: Map<string, string>;
  /** Drop every client's socket, as a broker restart would. */
  dropClients(): void;
  close(): Promise<void>;
}

export async function startBroker(): Promise<Broker> {
  const sockets = new Set<Socket>();
  const broker: Omit<Broker, "url"> = {
    connects: [],
    retained: new Map(),
    dropClients: () => {
      for (const socket of sockets) socket.destroy();
    },
    close: () =>
      new Promise((resolve) => {
        broker.dropClients();
        server.close(() => resolve());
      }),
  };

  const server: Server = createServer((socket) => {
    sockets.add(socket);
    const parser = mqttPacket.parser({ protocolVersion: 4 });
    let will: { topic: string; payload: string; retain: boolean } | null = null;
    const send = (packet: mqttPacket.Packet) => socket.write(mqttPacket.generate(packet));

    parser.on("packet", (packet) => {
      switch (packet.cmd) {
        case "connect": {
          const password = packet.password ? Buffer.from(packet.password).toString() : undefined;
          if (packet.will) {
            will = {
              topic: packet.will.topic,
              payload: Buffer.from(packet.will.payload).toString(),
              retain: packet.will.retain === true,
            };
          }
          broker.connects.push({
            clientId: packet.clientId,
            username: packet.username,
            password,
            will: will ? { topic: will.topic, payload: will.payload } : undefined,
          });
          send({ cmd: "connack", returnCode: 0, sessionPresent: false });
          break;
        }
        case "publish":
          if (packet.retain) broker.retained.set(packet.topic, packet.payload.toString());
          if (packet.qos === 1) send({ cmd: "puback", messageId: packet.messageId! });
          break;
        case "pingreq":
          send({ cmd: "pingresp" });
          break;
        case "disconnect":
          will = null;
          socket.end();
          break;
      }
    });
    socket.on("data", (chunk: Buffer) => parser.parse(chunk));
    socket.on("close", () => {
      sockets.delete(socket);
      if (will?.retain) broker.retained.set(will.topic, will.payload);
    });
    socket.on("error", () => undefined);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { ...broker, url: `mqtt://127.0.0.1:${port}` } as Broker;
}
