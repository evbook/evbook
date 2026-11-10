// Build settings for `cf build` / `cf deploy`, which bundle with Wrangler here.
// The Worker itself is described in cloudflare.config.ts. The assets are the
// Vite build of app/ — `bun run build:app` writes them before cf runs.
import { defineWranglerConfig } from "wrangler/experimental-config";

export default defineWranglerConfig({
  assetsDirectory: "dist/client",
});
