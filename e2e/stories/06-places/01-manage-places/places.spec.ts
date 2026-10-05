import { expect, step, test } from "../../../harness/story";

/**
 * See story.md. This story writes, and cleans up after itself by deleting the
 * place it created, so the seeded four are what the other stories see.
 */
test("owner adds, edits and removes a place", async ({ page, story }) => {
  // Scoped to the geo-fence table by a column only it has: the page also carries the
  // address roll-up's two tables, and an unscoped row locator counts those as well.
  const rows = page
    .getByRole("table")
    .filter({ has: page.getByRole("columnheader", { name: "Radius" }) })
    .locator("tbody tr");

  await step("the places that already exist", async () => {
    await story.goto("/geofences");
    await expect(page.getByRole("heading", { name: "Geo-fences" })).toBeVisible();
    await expect(rows).toHaveCount(4);
    await story.shot("places list");
  });

  await step("the new-place form", async () => {
    await page.getByRole("link", { name: /New geo-fence/ }).click();
    await expect(page.getByRole("heading", { name: "New geo-fence" })).toBeVisible();
    await expect(page.locator(".leaflet-container")).toBeVisible();
    await story.shot("new place form");
  });

  await step("name it, size it, price it", async () => {
    await page.getByLabel("Name").fill("Friend's driveway");
    await page.getByLabel("Radius (metres)").fill("90");
    await page.getByLabel("Billed").selectOption("per_kwh");
    await page.getByLabel("Rate").fill("0.24");
    await story.shot("form filled in");
    await page.getByRole("button", { name: "Save geo-fence" }).click();
    await expect(page.getByRole("heading", { name: "Geo-fences" })).toBeVisible();
    // Scoped to the table, like every other reference to the row below. Naming a
    // place puts that name in a second place on this page: the address roll-up
    // badges the stops that fall inside it, and this radius covers a seeded one
    // whenever the map's default centre lands near where the car actually parks.
    await expect(rows.filter({ hasText: "Friend's driveway" })).toHaveCount(1);
    await expect(rows).toHaveCount(5);
    await story.shot("place created");
  });

  await step("change the rate", async () => {
    await rows.filter({ hasText: "Friend's driveway" }).getByRole("link", { name: "Edit" }).click();
    await expect(page.getByRole("heading", { name: "Edit geo-fence" })).toBeVisible();
    await page.getByLabel("Rate").fill("0.31");
    await page.getByRole("button", { name: "Save geo-fence" }).click();
    const row = rows.filter({ hasText: "Friend's driveway" });
    await expect(row).toContainText("0.31");
    await story.shot("rate updated");
  });

  await step("remove it again", async () => {
    const row = rows.filter({ hasText: "Friend's driveway" });
    await row.getByRole("button", { name: "Delete" }).click();
    await row.getByRole("button", { name: "Confirm" }).click();
    await expect(rows).toHaveCount(4);
    await story.shot("place removed");
  });

  await step("everywhere the car has been", async () => {
    await page.getByText("Everywhere the car has been").scrollIntoViewIfNeeded();
    // The geocoding is already being paid for; this is what it buys.
    await expect(page.getByText("Countries")).toBeVisible();
    const cities = page.getByRole("table").filter({ has: page.getByRole("columnheader", { name: "City" }) });
    await expect(cities.getByRole("cell", { name: "Berlin" }).first()).toBeVisible();
    // Arrivals, so a city the car only drove through never appears.
    await expect(page.getByText("Where it has been lately")).toBeVisible();
    await story.shot("addresses the car has arrived at");
  });
});
