import { expect, step, test } from "../../../harness/story";

/**
 * See story.md. This story writes: it overrides the session cost, so it runs
 * against the seeded database and leaves that one session repriced.
 */
test("owner inspects a DC session and reprices it", async ({ page, story }) => {
  await step("open the Leipzig fast charge", async () => {
    await story.goto("/charges?q=Leipzig&type=dc");
    const session = page.locator("tbody tr").first();
    await expect(session).toContainText("DC");
    await session.getByRole("link", { name: "Details" }).click();
    await expect(page.getByRole("heading", { name: "Supercharger Leipzig Nord" })).toBeVisible();
    // The second row of tiles: the extremes that used to hide in a details table.
    await expect(page.getByText("Max power")).toBeVisible();
    await expect(page.getByText("Supply at peak")).toBeVisible();
    await story.shot("session header");
  });

  await step("the telemetry chart opens on power and battery", async () => {
    await expect(page.getByText("Telemetry", { exact: true })).toBeVisible();
    // Two chips is the default, and the shape that keeps both axes: power's on
    // the left, battery's on the right, each wearing its line's color.
    expect(await page.locator(".recharts-line-curve").count()).toBe(2);
    expect(await page.locator(".recharts-yAxis").count()).toBe(2);
    await story.shot("telemetry chart", { fullPage: true });
  });

  await step("the taper reads against state of charge", async () => {
    await page.getByRole("button", { name: "Battery %", exact: true }).click();
    // Battery is the x-axis now, so its chip sits the mode out and the power
    // line alone is the classic charging curve.
    await expect(page.getByRole("button", { name: "Battery", exact: true })).toBeDisabled();
    await expect(page.locator(".recharts-line-curve")).toHaveCount(1);
    await expect(page.locator(".recharts-xAxis-tick-labels").getByText(/%/).first()).toBeVisible();
    await story.shot("charging curve by state of charge");
  });

  await step("more parameters trade the axes for height", async () => {
    await page.getByRole("button", { name: "Voltage", exact: true }).click();
    await page.getByRole("button", { name: "Current", exact: true }).click();
    // Past two chips there is no side left for an axis, so every line spans
    // its own full-height scale and the figures stay in the tooltip.
    await expect(page.locator(".recharts-line-curve")).toHaveCount(3);
    await expect(page.locator(".recharts-yAxis")).toHaveCount(0);
    await story.shot("supply added, no axes");
  });

  await step("override the total cost", async () => {
    await page.getByLabel("Total").fill("13.37");
    await page.getByRole("button", { name: "Save" }).click();
    // The Cost tile repeats the figure back, which is the proof the new price
    // landed; its hint re-derives the effective per-kWh rate from it.
    await expect(page.getByText("13.37")).toBeVisible({ timeout: 15_000 });
    await story.shot("cost overridden beside the map", { fullPage: true });
  });
});
