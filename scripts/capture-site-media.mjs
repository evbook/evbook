// Captures the product screenshots the landing page and the README show, from
// a running demo. Run with the demo up (`bun run demo`, or the evbook-demo
// launch configuration), then:
//
//   bun scripts/capture-site-media.mjs [http://localhost:8787]
//
// Writes, once per colour scheme — the landing page and GitHub both follow the
// reader's, the same way the app does:
//
//   site/media/overview-{light,dark}.webp   the landing page's hero (and the README's)
//   docs/media/<page>-{light,dark}.webp     the README's tour of the other pages
//
// Needs `cwebp` on the PATH (brew install webp); the PNGs it starts from are
// left in a temp dir.
import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const origin = process.argv[2] ?? "http://localhost:8787";
const root = join(import.meta.dirname, "..");
const tmp = mkdtempSync(join(tmpdir(), "evbook-shots-"));

/**
 * `open` is the first row of a list to follow into its detail page; `width`
 * scales the 2880px capture down — the README shows these two to a row, so the
 * full-density file would be four times the pixels anybody sees.
 */
const SHOTS = [
  { dir: "site/media", name: "overview", path: "/" },
  { dir: "docs/media", name: "drive", path: "/drives", open: 'a[href^="/drives/"]', width: 1600 },
  { dir: "docs/media", name: "charge", path: "/charges", open: 'a[href^="/charges/"]', width: 1600 },
  { dir: "docs/media", name: "trips", path: "/trips", width: 1600 },
  { dir: "docs/media", name: "statistics", path: "/stats", width: 1600 },
  { dir: "docs/media", name: "battery-health", path: "/health", width: 1600 },
  { dir: "docs/media", name: "history", path: "/history", width: 1600 },
];

const browser = await chromium.launch();
for (const scheme of ["light", "dark"]) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: scheme,
  });
  const page = await context.newPage();
  for (const shot of SHOTS) {
    await page.goto(`${origin}${shot.path}`, { waitUntil: "networkidle" });
    if (shot.open) {
      await page.locator(shot.open).first().click();
      await page.waitForLoadState("networkidle");
      // Off the row it just clicked, or the chart that lands under the pointer
      // is photographed with its tooltip open.
      await page.mouse.move(0, 0);
    }
    // The map tiles arrive after the network has otherwise gone quiet; a card
    // with a map in it is not a card without them. Pages without a map just
    // wait the second and a half for their charts to finish drawing.
    await page.waitForSelector(".leaflet-tile-loaded", { timeout: 5_000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const png = join(tmp, `${shot.name}-${scheme}.png`);
    await page.screenshot({ path: png });
    mkdirSync(join(root, shot.dir), { recursive: true });
    const file = `${shot.dir}/${shot.name}-${scheme}.webp`;
    const resize = shot.width ? ["-resize", String(shot.width), "0"] : [];
    execFileSync("cwebp", ["-q", "82", "-m", "6", "-quiet", ...resize, png, "-o", join(root, file)]);
    console.log(`wrote ${file}`);
  }
  await context.close();
}
await browser.close();
