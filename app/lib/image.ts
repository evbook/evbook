/**
 * Client-side re-encode of a picked document photo, so what goes over the
 * wire is small. The browser's own encoder decides the format: AVIF where it
 * can encode it, WebP otherwise, and failing both the image keeps its JPEG or
 * PNG shape. Detection is by trying — `canvas.toBlob` hands back its fallback
 * type (PNG) when it cannot encode what was asked for, which is the one
 * signal every browser agrees on.
 *
 * PDFs and anything else that is not an image pass through untouched; the
 * server's allowlist decides what it will keep.
 */

export interface PreparedUpload {
  blob: Blob;
  contentType: string;
  name: string;
  /**
   * A small preview for the document list, made from the same decode. null
   * when there is nothing to make one from — a PDF, or an image the browser
   * could not decode — and the list shows a placeholder tile instead.
   */
  thumbnail: { blob: Blob; contentType: string } | null;
}

/** What the server accepts without re-encoding (src/api/documents.ts). */
const UPLOADABLE_IMAGE_TYPES = new Set(["image/avif", "image/webp", "image/jpeg", "image/png"]);

/** Longest side after scaling — plenty for a legible scan of a document. */
const MAX_DIMENSION = 2560;
const QUALITY = 0.85;

/** Longest side of the list preview — a 48 px tile on a 3× display. */
const THUMB_DIMENSION = 256;
const THUMB_QUALITY = 0.7;

const EXTENSIONS: Record<string, string> = {
  "image/avif": "avif",
  "image/webp": "webp",
  "image/jpeg": "jpg",
  "image/png": "png",
};

function encode(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

async function encodesTo(type: string): Promise<boolean> {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const blob = await encode(canvas, type);
  return blob?.type === type;
}

let bestEncoding: Promise<string | null> | null = null;

/** The smallest format this browser can *encode*, probed once per session. */
function pickEncoding(): Promise<string | null> {
  bestEncoding ??= (async () => {
    for (const type of ["image/avif", "image/webp"]) {
      if (await encodesTo(type)) return type;
    }
    return null;
  })();
  return bestEncoding;
}

function renamed(name: string, type: string): string {
  const extension = EXTENSIONS[type];
  if (!extension) return name;
  const stem = name.replace(/\.[^./]+$/, "");
  return `${stem || name}.${extension}`;
}

/**
 * Turn a picked file into what should be uploaded. Images are decoded,
 * scaled down and re-encoded; if all of that gains nothing over an original
 * the server would accept anyway, the original wins. Throws when the file is
 * an image the browser cannot decode (a HEIC on most of them) — there is
 * nothing sensible to upload then, and the caller shows the message.
 */
export async function prepareDocument(file: File): Promise<PreparedUpload> {
  if (!file.type.startsWith("image/")) {
    return { blob: file, contentType: file.type, name: file.name, thumbnail: null };
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    if (UPLOADABLE_IMAGE_TYPES.has(file.type)) {
      // Undecodable here but in a format the server takes as-is — odd, but
      // the original is still the best available answer.
      return { blob: file, contentType: file.type, name: file.name, thumbnail: null };
    }
    throw new Error(`This browser cannot read ${file.name} — export it as JPEG or PNG and try again.`);
  }

  try {
    const target =
      (await pickEncoding()) ?? (file.type === "image/png" ? "image/png" : "image/jpeg");

    // The preview rides along on every path below — even where the original
    // file beats the re-encode, the decode is already paid for.
    const thumbBlob = await encodeScaled(bitmap, THUMB_DIMENSION, target, THUMB_QUALITY);
    const thumbnail = thumbBlob && thumbBlob.type === target ? { blob: thumbBlob, contentType: thumbBlob.type } : null;

    const scale = Math.min(1, MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
    const blob = await encodeScaled(bitmap, MAX_DIMENSION, target, QUALITY);
    if (!blob || blob.type !== target) {
      if (UPLOADABLE_IMAGE_TYPES.has(file.type)) {
        return { blob: file, contentType: file.type, name: file.name, thumbnail };
      }
      throw new Error(`This browser could not convert ${file.name} — export it as JPEG or PNG and try again.`);
    }

    // Re-encoding an already-small, already-acceptable file can come out
    // bigger than it went in; keep the original when it does.
    if (blob.size >= file.size && scale === 1 && UPLOADABLE_IMAGE_TYPES.has(file.type)) {
      return { blob: file, contentType: file.type, name: file.name, thumbnail };
    }
    return { blob, contentType: blob.type, name: renamed(file.name, blob.type), thumbnail };
  } finally {
    bitmap.close();
  }
}

/** Draw the bitmap scaled down to fit the given longest side, then encode. */
function encodeScaled(bitmap: ImageBitmap, maxDimension: number, type: string, quality: number): Promise<Blob | null> {
  const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return encode(canvas, type, quality);
}
