import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

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
      const version = createHash("sha256").update(source).update(precache.join("\n")).digest("hex").slice(0, 12);
      this.emitFile({
        type: "asset",
        fileName: "sw.js",
        source: source.replace('"__PRECACHE__"', JSON.stringify(precache)).replace("__VERSION__", version),
      });
    },
  };
}

/**
 * Which commit this build is of, for Settings to show beside the version: the
 * short revision and when it was committed. Asked of git, so it is the build's
 * own commit rather than the release's — a build from a checkout a few commits
 * past the tag says so.
 *
 * A build with no repository around it (the Docker image, whose context leaves
 * `.git` out) is told through BUILD_REVISION and BUILD_COMMITTED_AT instead;
 * with neither, the page shows the version alone. Only the app is stamped: it
 * is the one place this is shown, and it is always built and deployed together
 * with the server it talks to.
 */
function buildInfo(): { revision: string | null; committedAt: number | null } {
  const git = (...args: string[]): string | null => {
    try {
      const out = execFileSync("git", args, { cwd: import.meta.dirname, stdio: ["ignore", "pipe", "ignore"] });
      return out.toString().trim() || null;
    } catch {
      return null;
    }
  };
  const revision = process.env.BUILD_REVISION || git("rev-parse", "--short", "HEAD");
  // Seconds since the epoch, which is what `git log --format=%ct` prints.
  const seconds = Number(process.env.BUILD_COMMITTED_AT || git("log", "-1", "--format=%ct") || NaN);
  return { revision, committedAt: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null };
}

export default defineConfig({
  root: "app",
  define: { __BUILD__: JSON.stringify(buildInfo()) },
  plugins: [react(), tailwindcss(), serviceWorker()],
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
