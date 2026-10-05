import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, normalize, sep } from "node:path";
import type { BlobStore } from "../ports";

/**
 * The blob port over a directory of plain files — the Node stand-in for the
 * R2 bucket. A key maps straight onto a path under the root, so on a VPS a
 * document is just a file under the data volume and "back up = copy the
 * directory" stays true. The content type is ignored: the database row is
 * what downloads are served from.
 *
 * Keys are app-generated ids, but the traversal guard stays anyway (same
 * posture as assets.ts): a key that resolves outside the root is refused, so
 * a bug upstream cannot turn into a file write elsewhere.
 */
export function fileBlobs(directory: string): BlobStore {
  const root = normalize(directory);
  const resolve = (key: string): string => {
    const resolved = normalize(join(root, key));
    // `root + sep`, not `root`: a bare prefix check would wave through a
    // sibling directory that merely starts with the same name.
    if (!resolved.startsWith(root + sep)) throw new Error(`blob key escapes the store: ${key}`);
    return resolved;
  };

  return {
    async put(key, data) {
      const path = resolve(key);
      await mkdir(dirname(path), { recursive: true });
      // Write-then-rename: a crash mid-write leaves a stray .tmp, never a
      // half document behind a key the database already points at.
      const tmp = `${path}.tmp`;
      await writeFile(tmp, data);
      await rename(tmp, path);
    },
    async get(key) {
      try {
        return new Uint8Array(await readFile(resolve(key)));
      } catch {
        return null;
      }
    },
    async delete(key) {
      await unlink(resolve(key)).catch(() => undefined);
    },
  };
}
