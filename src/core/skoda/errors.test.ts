import { describe, expect, it } from "bun:test";
import { CHECK_TEXT, FAILURE_TEXT, classify, isKeyRefusal, problemOf, refusedReasonOf, retryAfterMs } from "./errors";

const problem = (type: string, title = "t") =>
  JSON.stringify({ type: `https://public.api.connect.skoda-auto.cz/problems/${type}`, title, status: 0 });

describe("classify", () => {
  it("tells the two 429s apart by the problem type", () => {
    expect(classify(429, problem("rate-limit-exceeded"), "120")).toMatchObject({
      kind: "rate_limited",
      retryInMs: 120_000,
    });
    expect(classify(429, problem("vehicle-not-accepting-requests"), "60")).toMatchObject({
      kind: "vehicle_refused",
      retryInMs: 60_000,
    });
    // An untyped 429 waits for the quota window: the cautious reading.
    expect(classify(429, "", null).kind).toBe("rate_limited");
  });

  it("names the refusals that only a new key can fix", () => {
    expect(classify(401, problem("api-key-expired")).kind).toBe("key_expired");
    expect(classify(403, problem("api-key-not-authorized")).kind).toBe("not_authorized");
    expect(classify(404, "").kind).toBe("not_found");
    for (const kind of ["key_expired", "not_authorized", "not_found"] as const) expect(isKeyRefusal(kind)).toBe(true);
    for (const kind of ["rate_limited", "vehicle_refused", "unavailable", "bad_request"] as const) {
      expect(isKeyRefusal(kind)).toBe(false);
    }
  });

  it("treats a 504 as the car not answering, and a 503 without Retry-After as ten seconds", () => {
    expect(classify(504, "").kind).toBe("vehicle_refused");
    expect(classify(503, "")).toMatchObject({ kind: "unavailable", retryInMs: 10_000 });
    expect(classify(500, "oops").kind).toBe("unavailable");
  });
});

describe("problemOf and retryAfterMs", () => {
  it("reads the problem type's last segment and its words, or the raw text", () => {
    expect(problemOf(problem("api-key-expired", "API key expired"))).toEqual({
      type: "api-key-expired",
      message: "API key expired",
    });
    expect(problemOf("<html>bad gateway</html>")).toEqual({ type: "", message: "<html>bad gateway</html>" });
  });

  it("reads Retry-After as seconds or as a date", () => {
    expect(retryAfterMs("30")).toBe(30_000);
    expect(retryAfterMs(new Date(1_000_000 + 5_000).toUTCString(), 1_000_000)).toBe(5_000);
    expect(retryAfterMs(null)).toBeNull();
    expect(retryAfterMs("soon")).toBeNull();
  });
});

describe("refusedReasonOf", () => {
  it("reads a stored reason, and takes one it does not know for a lapsed key", () => {
    expect(refusedReasonOf(null)).toBeNull();
    expect(refusedReasonOf("wrong_car")).toBe("wrong_car");
    expect(refusedReasonOf("something-newer")).toBe("key_expired");
  });

  it("has words for every reason in both places a refusal is shown", () => {
    for (const reason of ["key_expired", "not_authorized", "not_found", "wrong_car"] as const) {
      expect(FAILURE_TEXT[refusedReasonOf(reason)!]).toBeTruthy();
      expect(CHECK_TEXT[refusedReasonOf(reason)!]).toBeTruthy();
    }
  });
});
