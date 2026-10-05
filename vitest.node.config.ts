import path from "node:path";
import { defineConfig } from "vitest/config";

/**
 * The Node runtime's own suite: plain-Node vitest, no workerd. Everything else
 * stays on the workers pool (vitest.config.ts) — those specs exercising the
 * same actor and query code through the Cloudflare shells is the parity
 * guarantee between the two runtimes.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@shared": path.resolve(import.meta.dirname, "shared"),
    },
  },
  test: {
    include: ["src/platform/node/**/*.test.ts"],
    environment: "node",
    // The smoke test boots servers and replays imports; sequential keeps the
    // temp databases and ports from tripping over each other.
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
