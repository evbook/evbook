/**
 * Just enough ZIP to read a vendor export in place — central directory, then
 * one entry at a time through `DecompressionStream`, so a 60 MB CSV inside a
 * zip is never held in memory.
 *
 * Portable by design: the only thing it needs is random access to bytes, which
 * the CLI gives it from a file handle and a Worker could give it from an R2
 * object. Zip64 and encryption are not supported; both are reported clearly.
 */

export interface ByteReader {
  size: number;
  /** Bytes `[offset, offset + length)`. May return fewer bytes at EOF. */
  read(offset: number, length: number): Promise<Uint8Array>;
}

export interface ZipEntry {
  path: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  /** Offset of the local file header. */
  headerOffset: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_MAX_SIZE = 0xffff + 22; // comment field is at most 64 KiB
const ZIP64_MARKER = 0xffffffff;

export async function readZipEntries(reader: ByteReader): Promise<ZipEntry[]> {
  const tailSize = Math.min(reader.size, EOCD_MAX_SIZE);
  const tail = await reader.read(reader.size - tailSize, tailSize);
  const tailView = view(tail);

  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tailView.getUint32(i, true) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error("not a zip file (no end-of-central-directory record)");

  const count = tailView.getUint16(eocd + 10, true);
  const directorySize = tailView.getUint32(eocd + 12, true);
  const directoryOffset = tailView.getUint32(eocd + 16, true);
  if (directoryOffset === ZIP64_MARKER || directorySize === ZIP64_MARKER || count === 0xffff) {
    throw new Error("zip64 archives are not supported — unpack the export and import the directory instead");
  }

  const directory = await reader.read(directoryOffset, directorySize);
  const directoryView = view(directory);
  const decoder = new TextDecoder();
  const entries: ZipEntry[] = [];
  let cursor = 0;

  for (let i = 0; i < count && cursor + 46 <= directory.length; i++) {
    if (directoryView.getUint32(cursor, true) !== CENTRAL_SIGNATURE) {
      throw new Error(`corrupt zip: bad central directory entry at ${directoryOffset + cursor}`);
    }
    const flags = directoryView.getUint16(cursor + 8, true);
    const method = directoryView.getUint16(cursor + 10, true);
    const compressedSize = directoryView.getUint32(cursor + 20, true);
    const uncompressedSize = directoryView.getUint32(cursor + 24, true);
    const nameLength = directoryView.getUint16(cursor + 28, true);
    const extraLength = directoryView.getUint16(cursor + 30, true);
    const commentLength = directoryView.getUint16(cursor + 32, true);
    const headerOffset = directoryView.getUint32(cursor + 42, true);
    const path = decoder.decode(directory.subarray(cursor + 46, cursor + 46 + nameLength));
    cursor += 46 + nameLength + extraLength + commentLength;

    if (path.endsWith("/")) continue; // directory marker
    if (path.startsWith("__MACOSX/") || path.split("/").pop()?.startsWith("._")) continue;
    if ((flags & 0x1) !== 0) throw new Error(`${path} is encrypted — decrypt the export first`);
    if (compressedSize === ZIP64_MARKER || uncompressedSize === ZIP64_MARKER) {
      throw new Error(`${path} uses zip64 sizes — unpack the export and import the directory instead`);
    }
    if (method !== 0 && method !== 8) {
      throw new Error(`${path} uses unsupported zip compression method ${method}`);
    }
    entries.push({ path, method, compressedSize, uncompressedSize, headerOffset });
  }

  return entries;
}

const READ_CHUNK = 256 * 1024;

/** Decompressed bytes of one entry. */
export async function* readZipEntry(reader: ByteReader, entry: ZipEntry): AsyncIterable<Uint8Array> {
  const header = await reader.read(entry.headerOffset, 30);
  const headerView = view(header);
  if (headerView.getUint32(0, true) !== LOCAL_SIGNATURE) {
    throw new Error(`corrupt zip: bad local header for ${entry.path}`);
  }
  // The local header's extra field can differ in length from the central one's.
  const dataStart = entry.headerOffset + 30 + headerView.getUint16(26, true) + headerView.getUint16(28, true);

  const raw = readRange(reader, dataStart, entry.compressedSize);
  if (entry.method === 0) {
    yield* raw;
    return;
  }
  yield* inflate(raw);
}

export async function* readRange(reader: ByteReader, start: number, length: number): AsyncIterable<Uint8Array> {
  let offset = 0;
  while (offset < length) {
    const chunk = await reader.read(start + offset, Math.min(READ_CHUNK, length - offset));
    if (chunk.length === 0) throw new Error("unexpected end of data");
    offset += chunk.length;
    yield chunk;
  }
}

/** Raw deflate (or, for a `.gz` file, gzip) through the platform's own decompressor. */
export async function* inflate(
  chunks: AsyncIterable<Uint8Array>,
  format: "deflate-raw" | "gzip" = "deflate-raw",
): AsyncIterable<Uint8Array> {
  const iterator = chunks[Symbol.asyncIterator]();
  // Typed as BufferSource because that is what both the Workers and the DOM
  // definitions of DecompressionStream accept — this runs in a Worker, in Node
  // and in the browser.
  const source = new ReadableStream<Uint8Array<ArrayBuffer>>({
    async pull(controller) {
      const step = await iterator.next();
      if (step.done) controller.close();
      else controller.enqueue(step.value as Uint8Array<ArrayBuffer>);
    },
    async cancel() {
      await iterator.return?.();
    },
  });

  // Structural cast rather than `ReadableWritablePair`: that alias exists in the
  // Workers and DOM libs but not in Node's globals, and this file compiles in all
  // three.
  const stream = source.pipeThrough(
    new DecompressionStream(format) as unknown as {
      readable: ReadableStream<Uint8Array>;
      writable: WritableStream<Uint8Array<ArrayBuffer>>;
    },
  );
  const streamReader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await streamReader.read();
      if (done) return;
      if (value) yield value as Uint8Array;
    }
  } finally {
    streamReader.releaseLock();
  }
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
