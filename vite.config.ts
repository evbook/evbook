import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { crc32, deflateRawSync } from "node:zlib";

const APP = path.resolve(import.meta.dirname, "app");

/** Every file under `app/public`, as the root-relative URL it is served at. */
function publicUrls(dir = path.join(APP, "public"), prefix = ""): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    return statSync(full).isDirectory() ? publicUrls(full, `${prefix}/${entry}`) : [`${prefix}/${entry}`];
  });
}

/**
 * Emits `dist/client/sw.js` from `app/sw.js`, substituting the list of files
 * this build produced. The worker is written by hand rather than generated
 * wholesale, so it stays a file you can read; all this does is tell it the
 * hashed names it could not have known when it was written.
 *
 * It is emitted rather than copied out of `app/public` so that it can never be
 * served without the substitution having happened.
 */
function serviceWorker(): Plugin {
  return {
    name: "service-worker",
    apply: "build",
    generateBundle(_options, bundle) {
      const precache = [
        // The shell. Cloudflare serves `index.html` here and at every SPA route.
        "/",
        ...Object.keys(bundle)
          .filter((file) => file.endsWith(".js") || file.endsWith(".css"))
          .map((file) => `/${file}`),
        ...publicUrls(),
      ];
      const source = readFileSync(path.join(APP, "sw.js"), "utf8");
      // The cache name is keyed off both the file list and the worker's own
      // logic, so either changing retires the caches of previous builds.
      const version = createHash("sha256")
        .update(source)
        .update(precache.join("\n"))
        .digest("hex")
        .slice(0, 12);
      this.emitFile({
        type: "asset",
        fileName: "sw.js",
        source: source.replace('"__PRECACHE__"', JSON.stringify(precache)).replace("__VERSION__", version),
      });
    },
  };
}

/**
 * Emits `dist/client/evbook-token-helper.zip`: the browser extension in
 * `extension/`, packed as the Chrome Web Store upload (see
 * docs/token-helper/store-listing.md). A plain deflated zip is all the store
 * takes, so this writes one by hand rather than taking a dependency for it.
 */
function extensionZip(): Plugin {
  const root = path.resolve(import.meta.dirname, "extension");
  const files = (dir = root): string[] =>
    readdirSync(dir).flatMap((entry) => {
      const full = path.join(dir, entry);
      return statSync(full).isDirectory() ? files(full) : [full];
    });
  return {
    name: "extension-zip",
    apply: "build",
    generateBundle() {
      const local: Buffer[] = [];
      const central: Buffer[] = [];
      let offset = 0;
      for (const file of files().sort()) {
        const name = Buffer.from(path.relative(root, file).split(path.sep).join("/"));
        const data = readFileSync(file);
        const packed = deflateRawSync(data);
        // Fixed DOS date (1980-01-01) keeps the archive identical build to build.
        const fields = (h: Buffer, at: number) => {
          h.writeUInt16LE(20, at);
          h.writeUInt16LE(8, at + 4);
          h.writeUInt16LE(0x21, at + 8);
          h.writeUInt32LE(crc32(data), at + 10);
          h.writeUInt32LE(packed.length, at + 14);
          h.writeUInt32LE(data.length, at + 18);
          h.writeUInt16LE(name.length, at + 22);
        };
        const head = Buffer.alloc(30);
        head.writeUInt32LE(0x04034b50, 0);
        fields(head, 4);
        local.push(head, name, packed);
        const entry = Buffer.alloc(46);
        entry.writeUInt32LE(0x02014b50, 0);
        entry.writeUInt16LE(20, 4);
        fields(entry, 6);
        entry.writeUInt32LE(offset, 42);
        central.push(entry, name);
        offset += head.length + name.length + packed.length;
      }
      const dir = Buffer.concat(central);
      const end = Buffer.alloc(22);
      end.writeUInt32LE(0x06054b50, 0);
      end.writeUInt16LE(central.length / 2, 8);
      end.writeUInt16LE(central.length / 2, 10);
      end.writeUInt32LE(dir.length, 12);
      end.writeUInt32LE(offset, 16);
      this.emitFile({ type: "asset", fileName: "evbook-token-helper.zip", source: Buffer.concat([...local, dir, end]) });
    },
  };
}

export default defineConfig({
  root: "app",
  plugins: [react(), tailwindcss(), serviceWorker(), extensionZip()],
  resolve: {
    alias: {
      "@": APP,
      "@shared": path.resolve(import.meta.dirname, "shared"),
    },
  },
  build: { outDir: "../dist/client", emptyOutDir: true },
  server: {
    proxy: { "/api": "http://localhost:8787" },
  },
});
