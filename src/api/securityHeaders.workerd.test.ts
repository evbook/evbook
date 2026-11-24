import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/** The headers on the Worker's own answers, including the ones it hands over from Workers Assets. */
describe("security headers on Cloudflare", () => {
  it("are on the API's answers", async () => {
    const res = await SELF.fetch("https://x/api/v1/cars");
    expect(res.status).toBe(401);
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });

  it("are added to what the asset layer answers, whose headers cannot be changed", async () => {
    // A worker-first path with no route for this method falls through to the
    // asset binding; setting a header on its Response as-is throws.
    const res = await SELF.fetch("https://x/health_check", { method: "POST" });
    expect(res.status).not.toBe(500);
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });
});
