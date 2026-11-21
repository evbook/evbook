// Captures the product screenshots the landing page and the README show, from
// a running demo. Run with the demo up (`bun run demo`, or the evbook-demo
// launch configuration), then:
//
//   bun scripts/capture-site-media.mjs [http://localhost:8787]
//
// Writes, once per colour scheme — the landing page and GitHub both follow the
// reader's, the same way the app does:
//
//   docs/media/overview-{light,dark}.webp   the README's hero (and the landing page's)
//   docs/media/<page>-{light,dark}.webp     the README's tour of the other pages
//                                           (route-density: the drives page's map)
//   docs/media/<page>-map-{light,dark}.webp the map alone, for the landing page's cards
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
 * `open` is the first row of a list to follow into its detail page, or `pick`
 * asks the API which one; `expand` is a collapsed card or row to open (the
 * first match, or the one a function finds), or a list of toggles to click in
 * turn; `frame` is an element to scroll into view, its bottom near the bottom
 * of the frame; `mapOnly` also saves the map by itself. `width` scales the 2880px capture down — the README
 * shows these two to a row, so the full-density file would be four times the
 * pixels anybody sees.
 */
const SHOTS = [
  { dir: "docs/media", name: "overview", path: "/" },
  // A drive that leaves the city for the Autobahn, so its route shows the
  // speed colours from end to end rather than one shade of city blue.
  {
    dir: "docs/media",
    name: "drive",
    pick: fastDrive,
    frame: ".leaflet-container",
    mapOnly: true,
    width: 1600,
  },
  // The everyday drives only: all of them would fit the map to the road trips
  // across Europe, and the city they all start from would be one bright dot.
  {
    dir: "docs/media",
    name: "route-density",
    path: "/drives?range=all&distanceMax=30",
    // The filter panel opens for a URL that sets a range filter; the chip
    // under it says enough.
    expand: [
      'main button[aria-expanded="true"]:has-text("Filters")',
      'button[aria-expanded]:has-text("Route density")',
    ],
    frame: ".leaflet-container",
    mapOnly: true,
    width: 1600,
  },
  { dir: "docs/media", name: "charge", path: "/charges", open: 'a[href^="/charges/"]', width: 1600 },
  // The longest trip of the year opened, for a route with something to colour.
  {
    dir: "docs/media",
    name: "trips",
    path: "/trips",
    expand: longestTrip,
    frame: ".leaflet-container",
    width: 1600,
  },
  { dir: "docs/media", name: "statistics", path: "/stats", width: 1600 },
  { dir: "docs/media", name: "battery-health", path: "/health", width: 1600 },
  { dir: "docs/media", name: "history", path: "/history", width: 1600 },
];

/** The newest drive of 20–120 km that touched Autobahn speed. */
async function fastDrive(page) {
  const { drives } = await (await page.request.get(`${origin}/api/v1/drives?limit=200`)).json();
  const drive = drives.find((d) => d.speedMaxKmh >= 110 && d.distanceKm >= 20 && d.distanceKm <= 120) ?? drives[0];
  return `/drives/${drive.id}`;
}

/** Encodes `png` to `file` (relative to the repo), scaled to `width` if given. */
function webp(png, file, width) {
  const resize = width ? ["-resize", String(width), "0"] : [];
  execFileSync("cwebp", ["-q", "82", "-m", "6", "-quiet", ...resize, png, "-o", join(root, file)]);
  console.log(`wrote ${file}`);
}

/** The row of the longest trip listed, read off the distance each row shows. */
async function longestTrip(page) {
  const rows = page.locator('main button[aria-controls^="trip-"]');
  await rows.first().waitFor();
  const distances = await rows.evaluateAll((buttons) =>
    buttons.map((button) => {
      // The figures sit beside the button, not in it: climb to the row.
      let row = button;
      while (row && !/[\d,.]+\s*km/.test(row.textContent ?? "")) row = row.parentElement;
      return Number(/([\d,.]+)\s*km/.exec(row?.textContent ?? "")?.[1]?.replace(/,/g, "") ?? 0);
    }),
  );
  return rows.nth(distances.indexOf(Math.max(...distances)));
}

const browser = await chromium.launch();
for (const scheme of ["light", "dark"]) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: scheme,
  });
  const page = await context.newPage();
  for (const shot of SHOTS) {
    const path = shot.pick ? await shot.pick(page) : shot.path;
    await page.goto(`${origin}${path}`, { waitUntil: "networkidle" });
    if (shot.open) {
      await page.locator(shot.open).first().click();
      await page.waitForLoadState("networkidle");
    }
    if (shot.expand) {
      for (const selector of [shot.expand].flat()) {
        const toggle = typeof selector === "function" ? await selector(page) : page.locator(selector).first();
        await toggle.click();
        await page.waitForLoadState("networkidle");
      }
    }
    if (shot.frame) {
      const target = page.locator(shot.frame).first();
      await target.waitFor();
      // Bottom 48px above the fold, unless that would tuck its top under the
      // sticky header.
      await target.evaluate((el) => {
        const box = el.getBoundingClientRect();
        const header = document.querySelector("header")?.getBoundingClientRect().height ?? 0;
        const byBottom = box.bottom - (window.innerHeight - 48);
        const byTop = box.top - header - 16;
        window.scrollBy(0, Math.min(byBottom, byTop));
      });
    }
    // Off whatever it just clicked, or the chart that lands under the pointer
    // is photographed with its tooltip open.
    await page.mouse.move(0, 0);
    // The map tiles arrive after the network has otherwise gone quiet; a card
    // with a map in it is not a card without them. Pages without a map just
    // wait the second and a half for their charts to finish drawing.
    await page.waitForSelector(".leaflet-tile-loaded", { timeout: 5_000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const png = join(tmp, `${shot.name}-${scheme}.png`);
    await page.screenshot({ path: png });
    mkdirSync(join(root, shot.dir), { recursive: true });
    webp(png, `${shot.dir}/${shot.name}-${scheme}.webp`, shot.width);
    if (shot.mapOnly) {
      // The map alone, for the landing page's cards, where the whole page
      // would shrink it to a thumbnail.
      const mapPng = join(tmp, `${shot.name}-map-${scheme}.png`);
      await page.locator(".leaflet-container").first().screenshot({ path: mapPng });
      webp(mapPng, `${shot.dir}/${shot.name}-map-${scheme}.webp`, 1400);
    }
  }
  await context.close();
}
await browser.close();
