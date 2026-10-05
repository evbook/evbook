import { expect, step, test } from "../../../harness/story";

/**
 * See story.md. This story writes global settings and puts them back at the end,
 * so the rest of the suite still sees kilometres.
 */
test("owner switches units and tunes sleep", async ({ page, story }) => {
  await step("the settings page", async () => {
    await story.goto("/settings");
    await expect(page.getByText("Units and display preferences. Changes save immediately.")).toBeVisible();
    await story.shot("settings page", { fullPage: true });
  });

  await step("switch to miles", async () => {
    await page.getByLabel("Distance").selectOption("mi");
    await expect(page.getByLabel("Distance")).toHaveValue("mi");
    await story.shot("distance in miles");
  });

  await step("the drives list follows", async () => {
    await story.goto("/drives");
    await expect(page.getByRole("heading", { name: "Drives" })).toBeVisible();
    await expect(page.getByText(/\bmi\b/).first()).toBeVisible();
    await story.shot("drives in miles");
  });

  await step("give the car longer before it sleeps", async () => {
    await story.goto("/settings");
    await page.getByLabel("Idle time before sleeping").selectOption("20");
    await expect(page.getByLabel("Idle time before sleeping")).toHaveValue("20");
    await page.getByText("Fixture Bro").scrollIntoViewIfNeeded();
    await story.shot("sleep settings");
  });

  await step("check what the database says about itself", async () => {
    await expect(page.getByText("Data health", { exact: true })).toBeVisible();
    // Every table has a download beside its count, named for what it does rather
    // than for the table — "Drives" alone would be the navigation's link.
    const drives = page.getByRole("link", { name: "Download drives as CSV" });
    await drives.scrollIntoViewIfNeeded();
    await expect(drives).toHaveAttribute("href", "/api/v1/export/drives.csv");
    await expect(page.getByText(/^Last position logged:/)).toBeVisible();
    // The seeded world is a healthy one: the only open row is the state the car is
    // in now, which is what an open state row is for.
    await expect(page.getByText("Nothing looks half-written.")).toBeVisible();
    await story.shot("data health");
  });

  await step("put kilometres back", async () => {
    await page.getByLabel("Distance").selectOption("km");
    await expect(page.getByLabel("Distance")).toHaveValue("km");
    await story.shot("back to kilometres");
  });
});
