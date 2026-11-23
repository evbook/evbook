import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Hono } from "hono";
import { securityHeaders, THEME_SCRIPT_HASH } from "./securityHeaders";

const root = resolve(import.meta.dirname, "../..");
const NAMES = [
  "x-frame-options",
  "x-content-type-options",
  "referrer-policy",
  "content-security-policy",
  "content-security-policy-report-only",
];

async function middlewareHeaders(): Promise<Record<string, string>> {
  const app = new Hono().use("*", securityHeaders).get("/", (c) => c.text("ok"));
  const res = await app.request("/");
  return Object.fromEntries(NAMES.map((name) => [name, res.headers.get(name) ?? ""]));
}

/** The `/*` block of a Cloudflare `_headers` file, names lower-cased. */
function cloudflareHeaders(): Record<string, string> {
  const lines = readFileSync(resolve(root, "app/public/_headers"), "utf8").split("\n");
  const start = lines.findIndex((line) => line.trim() === "/*");
  expect(start).toBeGreaterThanOrEqual(0);
  const out: Record<string, string> = {};
  for (const line of lines.slice(start + 1)) {
    if (line.trim().startsWith("#")) continue;
    if (!/^\s+\S/.test(line)) break;
    const colon = line.indexOf(":");
    out[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return out;
}

describe("securityHeaders", () => {
  it("refuses framing, sniffing and path-revealing referrers", async () => {
    const headers = await middlewareHeaders();
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(headers["content-security-policy"]).toBe("frame-ancestors 'none'");
    expect(headers["content-security-policy-report-only"]).toContain("default-src 'self'");
  });

  it("sends nothing Hono would add by default beyond those", async () => {
    const app = new Hono().use("*", securityHeaders).get("/", (c) => c.text("ok"));
    const res = await app.request("/");
    for (const name of ["strict-transport-security", "cross-origin-opener-policy", "cross-origin-resource-policy"]) {
      expect(res.headers.get(name), name).toBeNull();
    }
  });

  it("matches what Cloudflare sends with the SPA", async () => {
    expect(cloudflareHeaders()).toEqual(await middlewareHeaders());
  });

  it("allows the inline theme script in index.html by its hash", () => {
    const html = readFileSync(resolve(root, "app/index.html"), "utf8");
    const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
    expect(inline).toHaveLength(1);
    const hash = createHash("sha256").update(inline[0]!).digest("base64");
    expect(THEME_SCRIPT_HASH).toBe(`'sha256-${hash}'`);
  });
});
