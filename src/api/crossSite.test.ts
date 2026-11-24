import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { rejectCrossSiteWrites } from "./crossSite";

const app = new Hono().use("*", rejectCrossSiteWrites).all("/thing", (c) => c.json({ ok: true }));

function request(method: string, site?: string) {
  return app.request("/thing", { method, headers: site === undefined ? {} : { "sec-fetch-site": site } });
}

describe("rejectCrossSiteWrites", () => {
  it("lets the app's own writes through", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect((await request(method, "same-origin")).status, method).toBe(200);
    }
  });

  it("refuses a write from a sibling subdomain, another site or a typed-in URL", async () => {
    for (const site of ["same-site", "cross-site", "none", "something-new"]) {
      const res = await request("POST", site);
      expect(res.status, site).toBe(403);
      expect(await res.json()).toEqual({ error: "cross_site_request" });
    }
  });

  it("leaves reads alone, whoever asks", async () => {
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      expect((await request(method, "cross-site")).status, method).toBe(200);
    }
  });

  it("lets a script without the header through", async () => {
    expect((await request("POST")).status).toBe(200);
    expect((await request("DELETE")).status).toBe(200);
  });
});
