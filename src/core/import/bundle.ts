import { linesFromChunks } from "./csv";
import { readZipEntries, readZipEntry, type ByteReader, type ZipEntry } from "./zip";
import type { BundleEntry, ImportBundle } from "./types";

/** Portable `ImportBundle` implementations. Reading from disk lives in the CLI. */

/** Reads an export straight out of its zip, without unpacking it. */
export function zipBundle(label: string, reader: ByteReader): ImportBundle {
  let cached: ZipEntry[] | null = null;

  async function zipEntries(): Promise<ZipEntry[]> {
    cached ??= await readZipEntries(reader);
    return cached;
  }

  return {
    label,
    async entries(): Promise<BundleEntry[]> {
      return (await zipEntries()).map((entry) => ({
        path: entry.path,
        name: baseName(entry.path),
        size: entry.uncompressedSize,
      }));
    },
    lines(path: string): AsyncIterable<string> {
      return linesFromChunks(
        (async function* () {
          const entry = (await zipEntries()).find((candidate) => candidate.path === path);
          if (!entry) throw new Error(`${path} is not in ${label}`);
          yield* readZipEntry(reader, entry);
        })(),
      );
    },
  };
}

/** In-memory bundle — what the adapter specs are written against. */
export function memoryBundle(label: string, files: Record<string, string>): ImportBundle {
  return {
    label,
    async entries(): Promise<BundleEntry[]> {
      return Object.entries(files).map(([path, content]) => ({
        path,
        name: baseName(path),
        size: content.length,
      }));
    },
    lines(path: string): AsyncIterable<string> {
      const content = files[path];
      if (content === undefined) throw new Error(`${path} is not in ${label}`);
      return (async function* () {
        for (const line of content.split("\n")) {
          yield line.endsWith("\r") ? line.slice(0, -1) : line;
        }
      })();
    },
  };
}

export function baseName(path: string): string {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return (slash === -1 ? path : path.slice(slash + 1)).toLowerCase();
}
