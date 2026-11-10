// Captures the product screenshots the landing page shows in its hero, from a
// running demo. Run with the demo up (`bun run demo`, or the evbook-demo launch
// configuration), then:
//
//   bun scripts/capture-site-media.mjs [http://localhost:8787]
//
// Writes site/media/overview-{light,dark}.webp — one per colour scheme, since
// the landing page follows the OS the same way the app does. Needs `cwebp` on
// the PATH (brew install webp); the PNGs it starts from are left in a temp dir.
import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const origin = process.argv[2] ?? "http://localhost:8787";
const out = join(import.meta.dirname, "..", "site", "media");
const tmp = mkdtempSync(join(tmpdir(), "evbook-shots-"));

const browser = await chromium.launch();
for (const scheme of ["light", "dark"]) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: scheme,
  });
  const page = await context.newPage();
  await page.goto(`${origin}/`, { waitUntil: "networkidle" });
  // The map tiles arrive after the network has otherwise gone quiet; the card
  // is not a card without them.
  await page.waitForSelector(".leaflet-tile-loaded", { timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const png = join(tmp, `overview-${scheme}.png`);
  await page.screenshot({ path: png });
  execFileSync("cwebp", ["-q", "82", "-m", "6", "-quiet", png, "-o", join(out, `overview-${scheme}.webp`)]);
  console.log(`wrote site/media/overview-${scheme}.webp`);
  await context.close();
}
await browser.close();
