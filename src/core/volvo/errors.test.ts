import { describe, expect, it } from "bun:test";
import { classify, errorMessage, quotaWaitMs, rateLimitWaitMs } from "./errors";

describe("errorMessage", () => {
  it("reads all four body shapes Volvo sends", () => {
    expect(errorMessage('{"error":{"message":"GONE","description":"Version 1 is removed."}}')).toBe(
      "GONE: Version 1 is removed.",
    );
    expect(errorMessage('{"code":"X","message":"Bad thing"}')).toBe("Bad thing");
    expect(errorMessage('{"statusCode":404,"message":"NOT_FOUND"}')).toBe("NOT_FOUND");
    expect(errorMessage("  plain text  ")).toBe("plain text");
    expect(errorMessage("x".repeat(500))).toHaveLength(200);
  });
});

describe("classify", () => {
  it("tells a spent quota from a refused endpoint, and parses the wait", () => {
    const quota = classify(
      403,
      '{"statusCode":403,"message":"Out of call volume quota. Quota will be replenished in 18:00:00."}',
    );
    expect(quota.kind).toBe("quota");
    expect(quota.retryInMs).toBe(18 * 3600_000);
    expect(classify(403, '{"error":{"message":"Access Denied"}}').kind).toBe("forbidden");
  });

  it("recognises a refused key by its message, whatever the status", () => {
    const body = '{"error":{"message":"Access denied due to invalid VCC-API-KEY. Make sure to provide a valid key"}}';
    expect(classify(401, body).kind).toBe("key_refused");
    expect(classify(403, '{"message":"missing subscription key"}').kind).toBe("key_refused");
    expect(classify(401, '{"error":{"message":"Invalid token"}}').kind).toBe("unauthorized");
  });

  it("tells a market Volvo does not serve from an unknown VIN", () => {
    expect(classify(404, '{"message":"Vehicle does not belong to allowed markets"}').kind).toBe("market");
    expect(classify(404, '{"message":"NOT_FOUND"}').kind).toBe("not_found");
  });

  it("takes a rate limit's wait from Retry-After, then the message, then a minute", () => {
    expect(classify(429, "Rate limit is exceeded", "7").retryInMs).toBe(7000);
    expect(classify(429, "Rate limit is exceeded. Try again in 12 seconds.").retryInMs).toBe(12_000);
    expect(classify(429, "Rate limit is exceeded").retryInMs).toBe(60_000);
  });

  it("treats anything else as transient", () => {
    expect(classify(500, "oops").kind).toBe("unavailable");
    expect(classify(502, "").kind).toBe("unavailable");
  });

  it("parses the helpers on their own", () => {
    expect(quotaWaitMs("Quota will be replenished in 0:05:30.")).toBe(330_000);
    expect(quotaWaitMs("no time here")).toBeNull();
    expect(rateLimitWaitMs("abc", "in 1 second")).toBe(1000);
  });
});
