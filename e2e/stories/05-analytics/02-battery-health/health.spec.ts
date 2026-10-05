import { expect, step, test } from "../../../harness/story";

/** See story.md. */
test("owner checks battery health and idle loss", async ({ page, story }) => {
  await step("the headline figures", async () => {
    await story.goto("/health");
    await expect(page.getByRole("heading", { name: "Health" })).toBeVisible();
    await expect(page.getByText("Usable capacity")).toBeVisible();
    // A dash here would mean the seeded sessions were too small to measure.
    await expect(page.getByText(/kWh/).first()).toBeVisible();
    await story.shot("health headline");
  });

  await step("capacity over time", async () => {
    await expect(page.getByText("Capacity", { exact: true })).toBeVisible();
    expect(await page.locator(".recharts-line-curve").count()).toBeGreaterThan(0);
    await story.shot("capacity over time");
  });

  await step("capacity by mileage", async () => {
    // The same estimates against the odometer, behind the switch on the one card.
    await page.getByRole("button", { name: "Mileage" }).click();
    await expect(page.getByRole("button", { name: "Mileage" })).toHaveAttribute("aria-pressed", "true");
    expect(await page.locator(".recharts-line-curve").count()).toBeGreaterThan(0);
    await story.shot("capacity by mileage");
  });

  await step("range vs temperature", async () => {
    await page.getByText("Range vs Temperature").scrollIntoViewIfNeeded();
    // Net is what the driving used; gross is what it cost to put back.
    await expect(page.getByText("Net, from the pack")).toBeVisible();
    await expect(page.getByText("Gross, from the wall")).toBeVisible();
    await expect(page.getByText("Lost while charging")).toBeVisible();
    // A line across the temperature bands, so the winter/summer difference is visible.
    expect(await page.locator(".recharts-area-curve").count()).toBeGreaterThan(0);
    // Frame the chart itself, not just the card title at the fold — the shot
    // documents the panel, and the chart is the panel's point. The mouse gets
    // parked first: it is still where the Mileage click left it, and the scroll
    // would slide the chart underneath it and pop a tooltip into the shot.
    await page.mouse.move(0, 0);
    await page.locator(".recharts-area-curve").scrollIntoViewIfNeeded();
    await story.shot("consumption by temperature");
  });

  await step("mileage over time", async () => {
    await page.getByText("Mileage over time").scrollIntoViewIfNeeded();
    // How to read the line is behind the ⓘ beside the title.
    await page.getByRole("button", { name: "Reading the line" }).click();
    await expect(page.getByText(/A straight line is a predictable routine/)).toBeVisible();
    expect(await page.locator(".recharts-line-curve").count()).toBeGreaterThan(0);
    await story.shot("odometer over time");
    await page.keyboard.press("Escape");
  });

  await step("idle loss and software updates", async () => {
    await expect(page.getByText("Idle loss").first()).toBeVisible();
    await expect(page.getByText("Software updates")).toBeVisible();
    await page.getByText("Software updates").scrollIntoViewIfNeeded();
    await expect(page.getByText("2026.14.3", { exact: false }).first()).toBeVisible();
    await story.shot("idle loss and updates");
  });
});
