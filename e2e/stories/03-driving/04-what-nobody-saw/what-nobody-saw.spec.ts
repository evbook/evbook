import { expect, step, test } from "../../../harness/story";

/** See story.md — the half-blind day five days ago in the seeded world. */
test("owner reads the drives and the charge the logger could not see", async ({ page, story }) => {
  await step("the drive list shows a bounded start and a reconstructed drive", async () => {
    await story.goto("/drives?sort=date&dir=desc");
    const hidden = page.locator("tbody tr").filter({ hasText: "Reconstructed" }).first();
    await expect(hidden).toContainText("Happened between");
    // A ranged start: two times joined by a dash before the arrow.
    const bounded = page
      .locator("tbody tr")
      .filter({ hasText: /\d{2}:\d{2}\s?(AM|PM)?–\d{2}:\d{2}/ })
      .first();
    await expect(bounded).toBeVisible();
    // Five days back is below the fold: bring both rows into the picture.
    await bounded.scrollIntoViewIfNeeded();
    await hidden.scrollIntoViewIfNeeded();
    await story.shot("bounded start and reconstructed drive");
  });

  await step("the reconstructed drive says what is and is not known", async () => {
    await page.locator("tbody tr").filter({ hasText: "Reconstructed" }).first().getByRole("link").first().click();
    await expect(page.getByText(/^Happened between/)).toBeVisible();
    await expect(page.getByText(/Nobody saw this drive/)).toBeVisible();
    // Only the two places it was read at: no samples to chart, no track to export.
    await expect(page.getByText("Telemetry", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "GPX" })).toHaveCount(0);
    await expect(page.locator(".leaflet-container")).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, 0));
    await story.shot("reconstructed drive detail");
  });

  await step("the charge nobody saw is priced as a range", async () => {
    await story.goto("/charges?sort=date&dir=desc");
    const hidden = page.locator("tbody tr").filter({ hasText: "Reconstructed" }).first();
    await expect(hidden).toContainText("Happened between");
    // From the home tariff over the state-of-charge rise: "€x.xx – €y.yy".
    await expect(hidden).toContainText(/\d\.\d{2}\s?–\s?\S*\d\.\d{2}/);
    await hidden.scrollIntoViewIfNeeded();
    await story.shot("reconstructed charge in the list");
  });
});
