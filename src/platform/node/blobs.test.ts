import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { fileBlobs } from "./blobs";

describe("fileBlobs", () => {
  function freshStore() {
    const root = mkdtempSync(join(tmpdir(), "evbook-blobs-"));
    return { root, store: fileBlobs(root) };
  }

  it("round-trips, overwrites and deletes", async () => {
    const { root, store } = freshStore();

    expect(await store.get("documents/a")).toBeNull();

    await store.put("documents/a", new Uint8Array([1, 2, 3]), "image/webp");
    expect(Array.from((await store.get("documents/a"))!)).toEqual([1, 2, 3]);
    // One file per key under the root, no .tmp left behind.
    expect(existsSync(join(root, "documents", "a"))).toBe(true);
    expect(existsSync(join(root, "documents", "a.tmp"))).toBe(false);

    await store.put("documents/a", new Uint8Array([9]), "image/webp");
    expect(Array.from((await store.get("documents/a"))!)).toEqual([9]);

    await store.delete("documents/a");
    expect(await store.get("documents/a")).toBeNull();
    // Deleting a missing key is not an error.
    await store.delete("documents/a");
  });

  it("refuses a key that escapes the root", async () => {
    const { store } = freshStore();
    await expect(store.put("../escape", new Uint8Array([1]), "x")).rejects.toThrow(/escapes/);
    await expect(store.delete("../escape")).rejects.toThrow(/escapes/);
    // get swallows filesystem errors into null, but never reads outside.
    expect(await store.get("../../etc/passwd")).toBeNull();
  });
});
