import { expect, step, test } from "../../../harness/story";

/**
 * See story.md. This story writes: it adds a dated price to Home, and removes
 * it again at the end, so the seeded flat price is what later stories see.
 */
test("owner puts home charging on an off-peak night tariff", async ({ page, story }) => {
  const rows = page
    .getByRole("table")
    .filter({ has: page.getByRole("columnheader", { name: "Radius" }) })
    .locator("tbody tr");
  // A week ago on Home's wall clock: the new price covers the half-blind
  // evening five days back, and nothing older.
  const weekAgo = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" }).format(
    new Date(Date.now() - 7 * 86_400_000),
  );

  async function openHome() {
    await story.goto("/geofences");
    await rows.filter({ hasText: "Home" }).getByRole("link", { name: "Edit" }).click();
    await expect(page.getByRole("heading", { name: "Edit geo-fence" })).toBeVisible();
  }

  await step("Home's price as it is", async () => {
    await openHome();
    const prices = page.getByRole("group", { name: "Dated prices" });
    await expect(prices.getByRole("button", { name: /^From / })).toHaveCount(1);
    await prices.scrollIntoViewIfNeeded();
    await story.shot("home's single price");
  });

  await step("a new price from a week ago, with an off-peak night", async () => {
    await page.getByRole("button", { name: "New price from…" }).click();
    await page.getByLabel("New price starts on").fill(weekAgo);
    await page.getByRole("button", { name: "Add price" }).click();
    await expect(page.getByRole("button", { name: `From ${weekAgo}` })).toHaveAttribute("aria-pressed", "true");
    // A copy of the latest price: the flat rate carried over.
    await expect(page.getByLabel("Rate (EUR)")).toHaveValue("0.28");

    await page.getByRole("button", { name: "Add time window" }).click();
    await expect(page.getByLabel("From", { exact: true })).toHaveValue("22:00");
    await expect(page.getByLabel("Until", { exact: true })).toHaveValue("06:00");
    await page.getByLabel("Price here (EUR)").fill("0.12");

    // Every night of the week is in the window, every afternoon is not.
    const preview = page.getByRole("figure", { name: "Week preview" });
    await expect(preview).toBeVisible();
    await expect(preview.locator('[data-window="0"]')).toHaveCount(7 * 8);
    await preview.scrollIntoViewIfNeeded();
    await story.shot("off-peak window and week preview");
  });

  await step("save it", async () => {
    await page.getByRole("button", { name: "Save geo-fence" }).click();
    await expect(page.getByRole("heading", { name: "Geo-fences" })).toBeVisible();
    await expect(rows.filter({ hasText: "Home" })).toContainText("1 time window");
    await story.shot("home with a time-of-use price");
  });

  await step("the charge nobody saw is a range across both rates", async () => {
    await story.goto("/charges?sort=date&dir=desc");
    const hidden = page.locator("tbody tr").filter({ hasText: "Reconstructed" }).first();
    await hidden.getByRole("link").first().click();
    await expect(page.getByText(/Nobody saw this charge/)).toBeVisible();
    const explanation = page.getByTestId("cost-explanation");
    await expect(explanation).toContainText("Off-peak");
    await expect(explanation).toContainText("estimated");
    await expect(explanation).toContainText(`price from ${weekAgo}`);
    // "€x.xx – €y.yy" in the Cost tile.
    await expect(page.getByText(/\d\.\d{2}\s?–\s?\S*\d\.\d{2}/).first()).toBeVisible();
    // Below the tiles: on a phone the line is a scroll away from the header.
    await explanation.scrollIntoViewIfNeeded();
    await story.shot("ranged cost with its explanation");
  });

  await step("back to the flat price", async () => {
    await openHome();
    await page.getByRole("button", { name: `From ${weekAgo}` }).click();
    await page.getByRole("button", { name: "Remove this price" }).click();
    await expect(page.getByRole("group", { name: "Dated prices" }).getByRole("button", { name: /^From / })).toHaveCount(
      1,
    );
    await page.getByRole("button", { name: "Save geo-fence" }).click();
    await expect(page.getByRole("heading", { name: "Geo-fences" })).toBeVisible();
    await expect(rows.filter({ hasText: "Home" })).not.toContainText("time window");
    await story.shot("home back on its flat price");
  });
});
