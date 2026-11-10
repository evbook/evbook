/**
 * The `story` fixture. Every user-story spec uses it to
 *
 *   - open pages on the right server with stubbed map tiles,
 *   - capture a numbered screenshot per step, per viewport,
 *   - and drop the screencast next to the story it belongs to.
 *
 * Artifacts land beside the story file:
 *
 *   stories/<category>/<story>/screens/<desktop|mobile>/01-step-name.png
 *   stories/<category>/<story>/video/<desktop|mobile>.webm
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { test as base, expect, type TestInfo } from "@playwright/test";
import { RUNTIME_FILE, type Runtime } from "./env";

export { expect };

/** A flat, theme-neutral stand-in for OpenStreetMap tiles, so runs stay offline. */
const TILE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">
  <rect width="256" height="256" fill="#eae6de"/>
  <g fill="#e0dbd0">
    <rect x="24" y="28" width="64" height="44" rx="3"/>
    <rect x="150" y="40" width="52" height="60" rx="3"/>
    <rect x="40" y="150" width="76" height="52" rx="3"/>
    <rect x="168" y="168" width="56" height="48" rx="3"/>
  </g>
  <g stroke="#cec7b8" stroke-width="1">
    <path d="M0 128h256M128 0v256"/>
  </g>
  <path d="M-8 210 L210 -8" stroke="#c9c1b0" stroke-width="10" fill="none"/>
  <path d="M0 128h256" stroke="#d6cfc0" stroke-width="6" fill="none"/>
</svg>`;

export interface Story {
  /** Navigate within the app worker and wait for it to settle. */
  goto(path: string): Promise<void>;
  /** Capture the viewport. `fullPage` grabs the whole scroll height instead. */
  shot(name: string, options?: { fullPage?: boolean }): Promise<void>;
  /** Wait for fonts, tiles and animations before capturing. */
  settle(): Promise<void>;
  /** Tell the mock car what to do: parked | driving | charging | asleep. */
  scenario(name: "parked" | "driving" | "charging" | "asleep"): Promise<void>;
  /** Base URL of the sign-in worker, which has auto-login switched off. */
  readonly authUrl: string;
  /** Base URL of the worker that actually polls the mock car. */
  readonly liveUrl: string;
  readonly runtime: Runtime;
}

function readRuntime(): Runtime {
  if (!existsSync(RUNTIME_FILE)) {
    throw new Error(
      `Missing ${RUNTIME_FILE}. Run the suite through "bun run e2e" so global setup can start the stack.`,
    );
  }
  return JSON.parse(readFileSync(RUNTIME_FILE, "utf8")) as Runtime;
}

/** Screens live next to the spec file, split by viewport. */
function screenDir(testInfo: TestInfo): string {
  return join(dirname(testInfo.file), "screens", testInfo.project.name);
}

function videoPath(testInfo: TestInfo): string {
  return join(dirname(testInfo.file), "video", `${testInfo.project.name}.webm`);
}

const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

export const test = base.extend<{ story: Story }>({
  story: async ({ page, context, baseURL }, use, testInfo) => {
    const runtime = readRuntime();

    // Stale screens would otherwise pile up when steps get renamed.
    const screens = screenDir(testInfo);
    rmSync(screens, { recursive: true, force: true });
    mkdirSync(screens, { recursive: true });

    await page.route(/tile\.openstreetmap\.org/, (route) =>
      route.fulfill({ status: 200, contentType: "image/svg+xml", body: TILE_SVG }),
    );

    // The clock is deliberately NOT pinned. Leaflet fades tiles in by comparing
    // `new Date()` against the fade's start, so a frozen clock leaves every tile
    // at opacity 0 and the maps come out blank. The seeded history is anchored to
    // the moment the suite started anyway, so real time is already the right time.

    let step = 0;

    const settle = async () => {
      await page.waitForLoadState("networkidle").catch(() => {});
      await page.evaluate(() => document.fonts.ready);
      // Leaflet fades tiles in and Recharts animates on mount.
      await page.waitForTimeout(400);
    };

    const story: Story = {
      runtime,
      authUrl: runtime.authUrl,
      liveUrl: runtime.liveUrl,
      async goto(path) {
        await page.goto(new URL(path, baseURL ?? runtime.appUrl).toString());
        await settle();
      },
      settle,
      async shot(name, options) {
        step++;
        const file = join(screens, `${String(step).padStart(2, "0")}-${slug(name)}.png`);
        await settle();
        await page.screenshot({ path: file, fullPage: options?.fullPage ?? false, animations: "disabled" });
        await testInfo.attach(`${testInfo.project.name}: ${name}`, { path: file, contentType: "image/png" });
      },
      async scenario(name) {
        const res = await page.request.post(`${runtime.mockUrl}/scenario/${name}`);
        expect(res.ok(), `switching the mock car to "${name}"`).toBeTruthy();
        /*
          Switching the mock only changes what the car *would* answer. Nothing
          reaches the page until the live worker polls again, and for a parked
          car that is INTERVALS.default away — 15 s, or 30 s while a suspend
          blocker holds it off — on top of the overview's own 5 s refresh. The
          stories that wait 30 s for a state to change were racing that, which
          is why they failed intermittently and only in whichever project ran
          second. `resume` re-arms the poll at INTERVALS.fallback, so the wait
          is bounded at ten seconds instead of being anyone's guess.
        */
        const poll = await page.request.put(`${runtime.liveUrl}/api/v1/cars/1/logging/resume`);
        expect(poll.ok(), `re-arming the live worker's poll after "${name}"`).toBeTruthy();
      },
    };

    await use(story);

    // The video file is only complete once the context is closed, so close it
    // here and copy it to the story folder before Playwright cleans up.
    const video = page.video();
    if (video) {
      await context.close();
      const target = videoPath(testInfo);
      mkdirSync(dirname(target), { recursive: true });
      await video.saveAs(target).catch(() => {});
    }
  },
});

/**
 * Wrapper so the numbered screenshots line up with the story's written steps and
 * the HTML report shows them as steps.
 */
export function step<T>(title: string, body: () => Promise<T>): Promise<T> {
  return test.step(title, body);
}
