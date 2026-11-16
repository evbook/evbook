import { describe, expect, it } from "vitest";
import type { MqttSettingsDto } from "@shared/api-types";
import { authed, login } from "../../test/http";
import { brokerUrlProblem } from "./mqtt";

/** On Cloudflare nothing publishes: the card is not offered and a change is refused. */

describe("MQTT settings on Cloudflare", () => {
  it("are not available", async () => {
    const cookie = await login();
    const body = (await (await authed(cookie, "/api/v1/mqtt")).json()) as MqttSettingsDto;
    expect(body).toMatchObject({
      available: false,
      enabled: false,
      passwordSet: false,
      prefix: "evbook",
      status: null,
    });
  });

  it("refuse a change", async () => {
    const cookie = await login();
    const res = await authed(cookie, "/api/v1/mqtt", {
      method: "PUT",
      body: JSON.stringify({ url: "mqtt://broker:1883", enabled: true }),
    });
    expect(res.status).toBe(409);
  });
});

describe("brokerUrlProblem", () => {
  it("takes the four MQTT schemes with a host, and empty for not set", () => {
    for (const url of [
      "",
      "mqtt://10.0.0.2:1883",
      "mqtts://broker.example",
      "ws://broker/mqtt",
      "wss://broker:443/mqtt",
    ]) {
      expect(brokerUrlProblem(url)).toBeNull();
    }
  });

  it("refuses anything else, and a login in the address", () => {
    for (const url of ["broker:1883", "http://broker", "mqtt://", "tcp://broker:1883"]) {
      expect(brokerUrlProblem(url)).toContain("mqtt://host:1883");
    }
    expect(brokerUrlProblem("mqtt://user:secret@broker:1883")).toContain("own fields");
  });
});
