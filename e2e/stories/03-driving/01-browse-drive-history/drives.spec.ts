import { expect, step, test } from "../../../harness/story";

/** See story.md — filters live in the URL, so each step is also a shareable link. */
test("owner narrows a long history down to one drive", async ({ page, story }) => {
  const rows = page.locator("tbody tr");

  await step("the whole history, newest first", async () => {
    await story.goto("/drives");
    await expect(page.getByRole("heading", { name: "Drives" })).toBeVisible();
    await expect(rows.first()).toBeVisible();
    // The count tile, after the page heading — scoped to the page, because the
    // navigation's own "Drives" link is one of two and which is shown depends on
    // the viewport.
    await expect(page.getByRole("main").getByText("Drives", { exact: true }).last()).toBeVisible();
    await story.shot("all drives", { fullPage: true });
  });

  await step("this month only", async () => {
    await page.getByRole("button", { name: "1M", exact: true }).click();
    await expect(page).toHaveURL(/range=1m/);
    await expect(rows.first()).toBeVisible();
    await story.shot("this month");
  });

  await step("and the month before it", async () => {
    // The arrows are what the presets are for: 1M picks the step, « walks it.
    await page.getByRole("button", { name: /^Previous month/ }).click();
    await expect(page).toHaveURL(/from=\d{4}-\d{2}-\d{2}/);
    await story.shot("previous month");
  });

  await step("search for the road trip", async () => {
    await page.getByRole("button", { name: "ALL", exact: true }).click();
    await page.getByPlaceholder("Search locations").fill("Leipzig");
    // Typing this soon after widening the range must not put the month back: both
    // changes compose onto the URL rather than each being written from the same
    // render, which is what used to leave the search applied to June alone.
    await expect(page).toHaveURL(/[?&]q=Leipzig/);
    await expect(page).not.toHaveURL(/range=/);
    await expect(rows).toHaveCount(2, { timeout: 15_000 });
    await story.shot("search leipzig");
  });

  await step("longest leg first", async () => {
    await page.getByRole("button", { name: /^Distance/ }).click();
    await expect(page).toHaveURL(/sort=distance/);
    await expect(rows.first()).toContainText("186");
    await story.shot("sorted by distance");
  });

  await step("route and charging for the selection", async () => {
    await page.getByRole("button", { name: /Route and charging/ }).click();
    await expect(page.getByText("Charging sessions")).toBeVisible();
    await expect(page.getByText("Energy charged")).toBeVisible();
    await story.shot("route and charging", { fullPage: true });
  });

  await step("clearing filters restores everything", async () => {
    await page.getByRole("button", { name: "Clear all" }).click();
    await expect(page.getByPlaceholder("Search locations")).toHaveValue("");
    await story.shot("filters cleared");
  });
});
