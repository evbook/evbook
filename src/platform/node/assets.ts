import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import type { AssetFetcher } from "../env";

/**
 * Serves the Vite build the way Workers Assets does: exact files with
 * immutable caching for the fingerprinted bundles, and `index.html` for every
 * other path — the `single-page-application` fallback the SPA router and the
 * service worker's precache both assume. The worker-first routing question
 * doesn't exist here: on Node everything goes through Hono first, and only its
 * `notFound` reaches this.
 */

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export function fileAssets(directory: string): AssetFetcher {
  const serve = async (path: string, headers: Record<string, string>): Promise<Response | null> => {
    // normalize() collapses any ../ the decode produced; anything that still
    // escapes the root resolves outside `directory` and readFile fails closed.
    const resolved = normalize(join(directory, path));
    if (!resolved.startsWith(normalize(directory))) return null;
    try {
      const body = await readFile(resolved);
      return new Response(new Uint8Array(body), {
        headers: { "content-type": CONTENT_TYPES[extname(resolved)] ?? "application/octet-stream", ...headers },
      });
    } catch {
      return null;
    }
  };

  return {
    async fetch(request: Request): Promise<Response> {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("method not allowed", { status: 405 });
      }
      let pathname: string;
      try {
        pathname = decodeURIComponent(new URL(request.url).pathname);
      } catch {
        return new Response("bad request", { status: 400 });
      }

      if (pathname !== "/" && !pathname.endsWith("/")) {
        // Vite fingerprints everything under /assets/, so those never change
        // under their name; the rest (sw.js, manifest, icons) must revalidate.
        const cache = pathname.startsWith("/assets/")
          ? "public, max-age=31536000, immutable"
          : "public, max-age=0, must-revalidate";
        const file = await serve(pathname, { "cache-control": cache });
        if (file) return file;
      }

      // SPA fallback: every unknown path renders the shell and the client
      // router takes it from there. Never cached, so a deploy shows up on the
      // next navigation.
      const shell = await serve("/index.html", { "cache-control": "no-cache" });
      return shell ?? new Response("not found", { status: 404 });
    },
  };
}
