#!/usr/bin/env bun
// Draws the app mark and rasterises the PWA icon set into `app/public/`.
//
// Run it when the mark changes; the output is committed, so a normal build and
// deploy never needs this script — nor `sharp`, which is a transitive dependency
// here rather than one this project declares:
//
//   bun scripts/make-icons.mjs
//
// The mark is lucide's `zap` — the same icon set the app renders with — filled
// rather than stroked so it survives being drawn at 16px in a browser tab, on a
// near-black square matching the app's own `--background` in dark mode.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const OUT = resolve(import.meta.dirname, "../app/public");

const BG = "#0a0a0a"; // oklch(0.145 0 0), the dark-mode `--background`
const FG = "#ffffff";

/** lucide `zap`, on a 24-unit grid: 18 wide, 20 tall, centred on (12, 12). */
const BOLT = "M13 2 3 14h9l-1 8 10-12h-9l1-8z";
const BOLT_HEIGHT = 20;

/**
 * @param size    canvas edge, in px
 * @param glyph   the bolt's height as a fraction of the canvas
 * @param radius  corner radius as a fraction of the canvas; 0 leaves the square
 *                full-bleed for a platform that applies its own mask
 */
function mark(size, glyph, radius) {
  const scale = (glyph * size) / BOLT_HEIGHT;
  const rx = radius ? ` rx="${(radius * size).toFixed(0)}"` : "";
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`,
    `  <rect width="${size}" height="${size}"${rx} fill="${BG}"/>`,
    `  <path d="${BOLT}" fill="${FG}" transform="translate(${size / 2} ${size / 2}) scale(${scale.toFixed(4)}) translate(-12 -12)"/>`,
    `</svg>`,
    ``,
  ].join("\n");
}

const files = [
  // The favicon, and the manifest's scalable entry. Kept as SVG so a tab at any
  // density draws it sharply.
  { path: "icon.svg", svg: mark(512, 0.62, 0.22) },
  // `purpose: "any"` — drawn as-is, so it carries its own rounded corners.
  { path: "icons/icon-192.png", svg: mark(512, 0.62, 0.22), size: 192 },
  { path: "icons/icon-512.png", svg: mark(512, 0.62, 0.22), size: 512 },
  // `purpose: "maskable"` — Android crops to a shape of its choosing and only
  // guarantees the centre 80%, so the square runs to the edge and the bolt sits
  // well inside the safe circle.
  { path: "icons/icon-maskable-512.png", svg: mark(512, 0.46, 0), size: 512 },
  // iOS masks this one itself, and shows a black rectangle where a PNG has
  // transparency — hence full-bleed again, with a gentler inset than maskable
  // because the superellipse takes far less than Android's worst case.
  { path: "icons/apple-touch-icon.png", svg: mark(512, 0.56, 0), size: 180 },
];

const { default: sharp } = await import("sharp").catch(() => {
  console.error("This script needs `sharp`: bun add --no-save sharp");
  process.exit(1);
});

for (const { path, svg, size } of files) {
  const out = join(OUT, path);
  mkdirSync(dirname(out), { recursive: true });
  if (size === undefined) writeFileSync(out, svg);
  else await sharp(Buffer.from(svg)).resize(size, size).png({ compressionLevel: 9 }).toFile(out);
  console.log(`wrote app/public/${path}`);
}
