import { linesFromChunks } from "./csv";
import { inflate, readRange, readZipEntries, readZipEntry, type ByteReader, type ZipEntry } from "./zip";
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

/**
 * Whatever the user picked: a zip (Tessie), or a single file — a TeslaMate
 * `pg_dump` backup, plain or gzipped. A single file becomes a one-entry bundle
 * named after it, with a trailing `.gz` dropped, so adapters see `teslamate.bck`
 * either way. Formats are told apart by their first bytes, not the file name.
 */
export async function fileBundle(label: string, reader: ByteReader): Promise<ImportBundle> {
  const head = await reader.read(0, 4);
  const zip = head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
  // A file named .zip that is not one is a broken download: say so, rather than
  // that no service recognises its contents.
  if (zip || /\.zip$/i.test(label)) return zipBundle(label, reader);
  if (reader.size === 0) throw new Error("the file is empty");

  const gzipped = head[0] === 0x1f && head[1] === 0x8b;
  const path = gzipped ? label.replace(/\.gz$/i, "") : label;
  return {
    label,
    async entries(): Promise<BundleEntry[]> {
      return [{ path, name: baseName(path), size: gzipped ? null : reader.size }];
    },
    lines(wanted: string): AsyncIterable<string> {
      if (wanted !== path) throw new Error(`${wanted} is not in ${label}`);
      const raw = readRange(reader, 0, reader.size);
      return linesFromChunks(gzipped ? inflate(raw, "gzip") : raw);
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
