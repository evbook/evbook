import { createReadStream } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { baseName, zipBundle } from "../../src/core/import/bundle";
import { linesFromChunks } from "../../src/core/import/csv";
import type { ByteReader } from "../../src/core/import/zip";
import type { BundleEntry, ImportBundle } from "../../src/core/import/types";

/** Reads an export from disk — either the vendor's zip or an unpacked folder. */

export interface OpenedBundle {
  bundle: ImportBundle;
  close(): Promise<void>;
}

export async function openBundle(path: string): Promise<OpenedBundle> {
  const info = await stat(path);
  if (info.isDirectory()) return { bundle: await directoryBundle(path), close: async () => {} };

  const handle = await open(path, "r");
  const reader: ByteReader = {
    size: info.size,
    async read(offset: number, length: number): Promise<Uint8Array> {
      const buffer = Buffer.allocUnsafe(length);
      // Positional reads, so the nine CSVs inside the zip can be walked at once.
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      return buffer.subarray(0, bytesRead);
    },
  };
  return { bundle: zipBundle(basename(path), reader), close: () => handle.close() };
}

async function directoryBundle(root: string): Promise<ImportBundle> {
  const names = await readdir(root);
  const entries: BundleEntry[] = [];
  for (const name of names) {
    const info = await stat(join(root, name));
    if (info.isFile()) entries.push({ path: name, name: baseName(name), size: info.size });
  }

  return {
    label: basename(root),
    async entries(): Promise<BundleEntry[]> {
      return entries;
    },
    lines(path: string): AsyncIterable<string> {
      return linesFromChunks(createReadStream(join(root, path)));
    },
  };
}
