import { expect, step, test } from "../../../harness/story";

/** See story.md — "Current" is the AC/DC filter, which lives behind the Filters button. */
test("owner separates cheap home charging from fast DC", async ({ page, story }) => {
  const rows = page.locator("tbody tr");

  await step("every session, newest first", async () => {
    await story.goto("/charges");
    await expect(page.getByRole("heading", { name: "Charges" })).toBeVisible();
    await expect(page.getByText("Energy added")).toBeVisible();
    await expect(rows.first()).toBeVisible();
    await story.shot("all sessions", { fullPage: true });
  });

  await step("where the charging happened", async () => {
    await expect(page.getByText("Where you charge")).toBeVisible();
    // One bubble per place, labelled with the number of sessions there.
    const bubbles = page.locator(".evbook-charge");
    expect(await bubbles.count()).toBeGreaterThan(1);
    await expect(bubbles.first()).toBeVisible();
    await story.shot("charging map");
  });

  await step("DC only", async () => {
    await page.getByRole("button", { name: /Filters/ }).click();
    await page.getByLabel("Current").selectOption("dc");
    await expect(rows).toHaveCount(2, { timeout: 15_000 });
    await expect(page.locator("tbody").getByText("DC").first()).toBeVisible();
    await story.shot("dc only", { fullPage: true });
  });

  await step("biggest session first", async () => {
    await page.getByRole("button", { name: /^Added/ }).click();
    await expect(page).toHaveURL(/sort=energy/);
    await story.shot("sorted by energy");
  });

  await step("back to everything", async () => {
    await page.getByLabel("Current").selectOption("");
    await expect(rows.first()).toBeVisible();
    await story.shot("filter cleared");
  });
});
