import { defineConfig, devices } from "@playwright/test";
import { APP_URL, ARTIFACT_DIR, STORIES_DIR, VIEWPORTS } from "./harness/env";

/**
 * User-story suite for the local stack. `harness/global-setup.ts` builds the SPA,
 * seeds three local SQLite databases and starts the mock Tesla API plus three
 * Node servers, so a run needs nothing but this repo.
 *
 * Every story runs at both sizes; screenshots and screencasts are written next
 * to the story they document.
 */
export default defineConfig({
  testDir: STORIES_DIR,
  testMatch: "**/*.spec.ts",
  outputDir: `${ARTIFACT_DIR}/test-results`,
  globalSetup: "./harness/global-setup.ts",
  globalTeardown: "./harness/global-teardown.ts",
  // Stories share one seeded database, and several of them write to it.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: [
    ["list"],
    ["html", { outputFolder: `${ARTIFACT_DIR}/report`, open: "never" }],
    ["json", { outputFile: `${ARTIFACT_DIR}/results.json` }],
  ],
  use: {
    baseURL: APP_URL,
    trace: "retain-on-failure",
    screenshot: "off",
    locale: "en-GB",
    timezoneId: "Europe/Berlin",
    // Screencast of every story, sized to the viewport under test.
    video: { mode: "on", size: VIEWPORTS.desktop },
  },
  projects: [
    {
      name: "desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: VIEWPORTS.desktop,
        video: { mode: "on", size: VIEWPORTS.desktop },
      },
    },
    {
      // iPhone 16 portrait, driven by Chromium so one browser download covers both.
      name: "mobile",
      use: {
        ...devices["Desktop Chrome"],
        viewport: VIEWPORTS.mobile,
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
        video: { mode: "on", size: VIEWPORTS.mobile },
      },
    },
  ],
});
