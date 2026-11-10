/**
 * Builds a ZIP archive in memory, for the specs that read one back — the zip
 * reader itself and the bundle that sits on top of it.
 *
 * CRCs are written as zero: the reader does not verify them, and `deflate-raw`
 * has already been trusted to round-trip by the platform.
 */

export interface ZipFileInput {
  name: string;
  content: string;
  /** Deflate the entry instead of storing it. */
  deflate?: boolean;
}

export async function buildZip(files: ZipFileInput[]): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const file of files) {
    const name = encoder.encode(file.name);
    const raw = encoder.encode(file.content);
    const method = file.deflate ? 8 : 0;
    const data = file.deflate ? await deflateRaw(raw) : raw;

    const local = new Uint8Array(30 + name.length + data.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(8, method, true);
    localView.setUint32(18, data.length, true);
    localView.setUint32(22, raw.length, true);
    localView.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(data, 30 + name.length);
    locals.push(local);

    const central = new Uint8Array(46 + name.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(10, method, true);
    centralView.setUint32(20, data.length, true);
    centralView.setUint32(24, raw.length, true);
    centralView.setUint16(28, name.length, true);
    centralView.setUint32(42, offset, true);
    central.set(name, 46);
    centrals.push(central);

    offset += local.length;
  }

  const directorySize = centrals.reduce((total, entry) => total + entry.length, 0);
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(8, files.length, true);
  eocdView.setUint16(10, files.length, true);
  eocdView.setUint32(12, directorySize, true);
  eocdView.setUint32(16, offset, true);

  return concat([...locals, ...centrals, eocd]);
}

/** A `ByteReader` over an in-memory archive. */
export function bytesReader(bytes: Uint8Array): {
  size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
} {
  return {
    size: bytes.length,
    async read(offset: number, length: number): Promise<Uint8Array> {
      return bytes.subarray(offset, Math.min(offset + length, bytes.length));
    },
  };
}

async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  // The copy pins the buffer type: Node's Blob types reject a possibly
  // SharedArrayBuffer-backed view, and this file compiles there too.
  const stream = new Blob([new Uint8Array(bytes)]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  const parts: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) parts.push(value as Uint8Array);
  }
  return concat(parts);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
