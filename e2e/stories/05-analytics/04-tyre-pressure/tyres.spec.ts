import { expect, step, test } from "../../../harness/story";

/** See story.md. */
test("owner spots a slow leak from the tyre history", async ({ page, story }) => {
  await step("the dot on the navigation, from any page", async () => {
    await story.goto("/drives");
    // Desktop shows it on the Insights menu in the header, a phone on the
    // Insights tab in the bottom bar: the one that is visible either way.
    const insights = page.getByRole("button", { name: /Insights/ });
    await expect(insights).toHaveAccessibleName(/tyre needs attention/);
    await expect(insights.getByTestId("tyre-attention-dot")).toBeVisible();
    await story.shot("dot on insights");
  });

  await step("Health carries the dot in the menu", async () => {
    await page.getByRole("button", { name: /Insights/ }).click();
    const health = page.getByRole("link", { name: /Health/ });
    await expect(health).toHaveAccessibleName(/tyre needs attention/);
    await expect(health.getByTestId("tyre-attention-dot")).toBeVisible();
    await story.shot("dot on health");
    await health.click();
    await expect(page.getByRole("heading", { name: "Health" })).toBeVisible();
  });

  await step("the tyre tile", async () => {
    const tile = page.getByTestId("tyre-tile");
    await expect(tile.getByTestId("tyre-rl")).toHaveAttribute("data-status", "low");
    await expect(tile.getByTestId("tyre-rl")).toContainText("2.40 bar");
    await expect(tile.getByTestId("tyre-rl")).toContainText("Recommended 2.90 bar");
    for (const corner of ["fl", "fr", "rr"]) {
      await expect(tile.getByTestId(`tyre-${corner}`)).toHaveAttribute("data-status", "ok");
    }
    await page.mouse.move(0, 0);
    // The low tyre, framed: on a phone the tile is taller than the screen.
    await tile.getByTestId("tyre-rl").evaluate((el) => el.scrollIntoView({ block: "center" }));
    await story.shot("tyre tile");
  });

  await step("how the status is decided", async () => {
    await page.getByRole("button", { name: "How tyre status is decided" }).click();
    await expect(page.getByText(/soft TPMS warning/)).toBeVisible();
    await story.shot("thresholds");
    await page.keyboard.press("Escape");
  });

  const history = page.getByTestId("tyre-history");

  await step("pressures over time", async () => {
    // Open from the start: a tyre is warning, and the slope is what to look at.
    await expect(history.getByRole("button", { name: "Pressures over time" })).toHaveAttribute("aria-expanded", "true");
    await expect(history.getByRole("region", { name: "Front axle" })).toBeVisible();
    await expect(history.getByRole("region", { name: "Rear axle" })).toBeVisible();
    // Left, right and the dashed recommendation on each axle.
    await expect(history.locator(".recharts-line-curve")).toHaveCount(6);
    await expect(history.locator(".recharts-line-curve[stroke-dasharray]")).toHaveCount(2);
    await page.mouse.move(0, 0);
    await history.getByRole("region", { name: "Rear axle" }).scrollIntoViewIfNeeded();
    await story.shot("pressures over thirty days");
  });

  await step("a year of it", async () => {
    await history.getByRole("button", { name: "12 months" }).click();
    await expect(history.getByRole("button", { name: "12 months" })).toHaveAttribute("aria-pressed", "true");
    await expect(history.getByText(/average of what was read in that week/)).toBeVisible();
    await expect(history.locator(".recharts-line-curve")).toHaveCount(6);
    await page.mouse.move(0, 0);
    await story.shot("pressures over twelve months");
  });

  await step("collapse the history", async () => {
    await history.getByRole("button", { name: "Pressures over time" }).click();
    await expect(history.getByRole("region", { name: "Front axle" })).toHaveCount(0);
    await story.shot("history collapsed");
  });
});
