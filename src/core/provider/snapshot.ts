/**
 * A provider's raw answer, reduced to what tells two answers apart.
 *
 * Every provider's answers are kept verbatim in `provider_snapshots`
 * (src/actors/providerPoll.ts), one row per distinct answer. "Distinct" is
 * decided here: the keys that change on every answer without the car changing
 * (capture timestamps, request ids) are dropped, the rest is hashed in a
 * stable key order. Which keys those are is the provider's to say.
 */

type Json = Record<string, unknown>;

function strip(x: unknown, volatile: ReadonlySet<string>): unknown {
  if (Array.isArray(x)) return x.map((item) => strip(item, volatile));
  if (!x || typeof x !== "object") return x;
  const o = x as Json;
  const out: Json = {};
  for (const key of Object.keys(o).sort()) {
    if (!volatile.has(key)) out[key] = strip(o[key], volatile);
  }
  return out;
}

/** SHA-256 of the answer without its `volatile` keys: equal means nothing new. */
export async function fingerprint(raw: unknown, volatile: ReadonlySet<string>): Promise<string> {
  const canonical = JSON.stringify(strip(raw, volatile));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
