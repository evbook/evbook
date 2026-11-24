import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Hono } from "hono";
import { securityHeaders, THEME_SCRIPT_HASH } from "./securityHeaders";

const root = resolve(import.meta.dirname, "../..");
/**
 * Every header the middleware adds, whatever its name: what a bare response
 * carries with it, less what the same response carries without it. A fixed
 * list would let a header added to the middleware alone slip past the
 * comparison with `_headers`.
 */
async function middlewareHeaders(): Promise<Record<string, string>> {
  const route = (app: Hono) => app.get("/", (c) => c.text("ok"));
  const bare = await route(new Hono()).request("/");
  const secured = await route(new Hono().use("*", securityHeaders)).request("/");
  return Object.fromEntries([...secured.headers].filter(([name, value]) => bare.headers.get(name) !== value));
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

  it("sends those five and nothing else Hono would add by default", async () => {
    expect(Object.keys(await middlewareHeaders()).sort()).toEqual([
      "content-security-policy",
      "content-security-policy-report-only",
      "referrer-policy",
      "x-content-type-options",
      "x-frame-options",
    ]);
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
