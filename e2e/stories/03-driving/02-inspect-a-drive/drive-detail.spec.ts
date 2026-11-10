import { expect, step, test } from "../../../harness/story";

/** See story.md — reached the way a user would, by filtering the list first. */
test("owner inspects the road trip in detail", async ({ page, story }) => {
  await step("open the longest drive from the list", async () => {
    await story.goto("/drives?q=Leipzig&sort=distance&dir=desc");
    const firstDrive = page.locator("tbody tr").first();
    await expect(firstDrive).toContainText("186");
    await firstDrive.getByRole("link", { name: "Details" }).click();
    // The two legs tie on distance, so either direction can be the top row.
    await expect(page.getByRole("heading", { name: /Leipzig Nord/ })).toBeVisible();
    await expect(page.getByText("Consumption")).toBeVisible();
    // The second row of tiles: the extremes that used to hide in a details table.
    await expect(page.getByText("Max speed")).toBeVisible();
    await expect(page.getByText("Max power")).toBeVisible();
    await story.shot("drive header and tiles");
  });

  await step("the route is drawn on the map", async () => {
    // Leaflet renders the traced path as an SVG polyline.
    await expect(page.locator(".leaflet-container path").first()).toBeVisible();
    await story.shot("route map");
  });

  await step("the telemetry chart opens on speed and power", async () => {
    await expect(page.getByText("Telemetry", { exact: true })).toBeVisible();
    // Two series is the default, and the shape that keeps both axes: speed's on
    // the left, power's on the right, each wearing its line's color.
    expect(await page.locator(".recharts-line-curve").count()).toBe(2);
    expect(await page.locator(".recharts-yAxis").count()).toBe(2);
    await story.shot("telemetry chart", { fullPage: true });
  });

  await step("more parameters trade the axes for height", async () => {
    await page.getByRole("button", { name: "Battery", exact: true }).click();
    await page.getByRole("button", { name: "Elevation", exact: true }).click();
    // Past two series there is no side left for an axis, so every line spans
    // its own full-height scale and the figures stay in the tooltip.
    await expect(page.locator(".recharts-line-curve")).toHaveCount(4);
    await expect(page.locator(".recharts-yAxis")).toHaveCount(0);
    await story.shot("four parameters, no axes");
  });

  await step("the x-axis can follow distance, and the setup keeps", async () => {
    await page.getByRole("button", { name: "Distance", exact: true }).click();
    // Recharts portals tick labels out of the axis group into a z-index layer,
    // so they are found by their own class rather than under .recharts-xAxis.
    await expect(page.locator(".recharts-xAxis-tick-labels").getByText(/km/).first()).toBeVisible();
    // The chart setup is a way of reading drives, not a fact about this one —
    // it has to survive leaving the page.
    await page.reload();
    await expect(page.locator(".recharts-line-curve")).toHaveCount(4);
    await expect(page.getByRole("button", { name: "Distance", exact: true })).toHaveAttribute("aria-pressed", "true");
    await story.shot("distance axis after a reload");
  });
});
