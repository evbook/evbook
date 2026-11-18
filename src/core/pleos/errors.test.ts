import { describe, expect, it } from "bun:test";
import { CHECK_TEXT, FAILURE_TEXT, classify, classifyToken, errorOf, refusedReasonOf } from "./errors";

const body = (code: string | number, message = "x") =>
  JSON.stringify({ error: { code, message, requestId: "req-1", details: [], timestamp: "2026-11-18T10:00:00Z" } });

describe("classify", () => {
  it("takes the live API's 403 with a numeric code for a refused token", () => {
    expect(classify(403, body(403))).toMatchObject({ kind: "token_refused", status: 403, code: "403" });
    expect(classify(401, "")).toMatchObject({ kind: "token_refused" });
  });

  it("reads the documented codes under HTTP 400, as strings or numbers", () => {
    expect(classify(400, body("4011")).kind).toBe("token_refused");
    expect(classify(400, body(40003)).kind).toBe("token_refused");
    expect(classify(400, body("40004")).kind).toBe("token_refused");
    expect(classify(400, body("5006")).kind).toBe("not_shared");
    expect(classify(410, body("4101")).kind).toBe("not_shared");
    expect(classify(400, body("4002")).kind).toBe("bad_request");
    expect(classify(400, body("40002")).kind).toBe("bad_request");
    expect(classify(400, body("404")).kind).toBe("bad_request");
  });

  it("tells no data apart from a refusal", () => {
    expect(classify(404, body("4045")).kind).toBe("no_data");
    expect(classify(404, "not found").kind).toBe("no_data");
  });

  it("waits on a 429 as told, but never less than five minutes, and a quarter of an hour untold", () => {
    expect(classify(429, "", "600").retryInMs).toBe(600_000);
    expect(classify(429, "", "10").retryInMs).toBe(300_000);
    expect(classify(429, "").retryInMs).toBe(900_000);
  });

  it("takes a 5xx or a gateway page as transient", () => {
    expect(classify(500, body("5001"))).toMatchObject({ kind: "unavailable" });
    expect(classify(502, "<html>bad gateway</html>")).toMatchObject({
      kind: "unavailable",
      code: null,
      message: "<html>bad gateway</html>",
    });
  });
});

describe("classifyToken", () => {
  it("takes Pleos's own refusal of personal-token as the key's, and a 429 or a 5xx as transient", () => {
    expect(classifyToken(404, body("40404")).kind).toBe("key_refused");
    expect(classifyToken(400, body("40001")).kind).toBe("key_refused");
    expect(classifyToken(401, "").kind).toBe("key_refused");
    expect(classifyToken(429, "").kind).toBe("rate_limited");
    expect(classifyToken(503, "").kind).toBe("unavailable");
  });

  it("does not blame the key for a 4xx that is not Pleos's answer", () => {
    // A firewall's or a gateway's page, and a request that timed out on the way.
    expect(classifyToken(403, "<html>Access denied</html>").kind).toBe("unavailable");
    expect(classifyToken(404, "").kind).toBe("unavailable");
    expect(classifyToken(408, body("408")).kind).toBe("unavailable");
    expect(classifyToken(403, "<html>Access denied</html>").retryInMs).toBeGreaterThan(0);
  });
});

describe("errorOf", () => {
  it("keeps Pleos's words and request id for the log, never more than 200 characters", () => {
    expect(errorOf(body("4045", "No Data"))).toEqual({ code: "4045", message: "No Data · req-1" });
    expect(errorOf("x".repeat(500)).message.length).toBe(200);
  });
});

describe("the words", () => {
  it("has words for every failure, none of them Pleos's own", () => {
    for (const text of [...Object.values(FAILURE_TEXT), ...Object.values(CHECK_TEXT)]) {
      expect(text.length).toBeGreaterThan(10);
      expect(text).not.toContain("req-");
    }
    expect(refusedReasonOf(null)).toBeNull();
    expect(refusedReasonOf("something new")).toBe("key_refused");
  });
});
