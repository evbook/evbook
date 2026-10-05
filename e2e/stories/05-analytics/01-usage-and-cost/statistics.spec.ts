import { expect, step, test } from "../../../harness/story";

/** See story.md. */
test("owner reviews usage and cost by period", async ({ page, story }) => {
  await step("monthly totals and charts", async () => {
    await story.goto("/stats");
    await expect(page.getByRole("heading", { name: "Statistics" })).toBeVisible();
    await expect(page.getByText("Energy charged")).toBeVisible();
    await expect(page.getByText("Distance and energy")).toBeVisible();
    await story.shot("statistics overview", { fullPage: true });
  });

  await step("group by week", async () => {
    await page.getByLabel("Group by").selectOption("week");
    await expect(page.getByText("Distance and energy")).toBeVisible();
    await story.shot("grouped by week");
  });

  await step("group by month again", async () => {
    await page.getByLabel("Group by").selectOption("month");
    await expect(page.getByText("Cost and consumption")).toBeVisible();
    await story.shot("grouped by month");
  });

  await step("how the car gets driven", async () => {
    await page.getByText("How the car gets driven").scrollIntoViewIfNeeded();
    // The median, not the mean: the figure that survives one airport run.
    await expect(page.getByText("Typical drive")).toBeVisible();
    await expect(page.getByText("median, not mean")).toBeVisible();
    // The lease-limit figure, extrapolated from the span that holds drives.
    await expect(page.getByText("On track for")).toBeVisible();
    // How the rates are worked out is one tap away rather than on the card.
    await page.getByRole("button", { name: "How the rates are worked out" }).click();
    await expect(page.getByText(/Rates are per day across the \d+ days that hold drives/)).toBeVisible();
    await story.shot("drive aggregates");
    await page.keyboard.press("Escape");
  });

  await step("time at speed, and where drives end", async () => {
    await expect(page.getByText("Time at speed")).toBeVisible();
    // Bars, one per speed band, not the line every other chart here draws.
    expect(await page.locator(".recharts-bar-rectangle").count()).toBeGreaterThan(0);
    await expect(page.getByText("Where drives end")).toBeVisible();
    // Scoped to this table: "Home" is also a top charging location further down.
    const destinations = page
      .getByRole("table")
      .filter({ has: page.getByRole("columnheader", { name: "Destination" }) });
    await expect(destinations.getByRole("cell", { name: "Home" })).toBeVisible();
    await story.shot("speed and destinations");
  });

  await step("what the electricity costs", async () => {
    await page.getByText("What the electricity costs").scrollIntoViewIfNeeded();
    // The petrol comparison, and the figure that says whether home charging pays.
    // Exact: the card's own description says "Cost per 100 km" too.
    await expect(page.getByText("Per 100 km", { exact: true })).toBeVisible();
    await expect(page.getByText("AC per kWh")).toBeVisible();
    await expect(page.getByText("DC per kWh")).toBeVisible();
    await expect(page.getByText("At Superchargers")).toBeVisible();
    await story.shot("cost per distance and per kwh");
  });

  await step("AC versus DC, and where the charging happened", async () => {
    await expect(page.getByText("AC vs DC")).toBeVisible();
    await expect(page.getByText("Top charging locations")).toBeVisible();
    await page.getByText("Top charging locations").scrollIntoViewIfNeeded();
    await story.shot("ac dc and locations");
  });

  await step("when charging happens, and how the taper looks", async () => {
    await page.getByText("When charging happens").scrollIntoViewIfNeeded();
    // A full week of rows whatever the data, so the grid never reads lopsided.
    const heatmap = page.getByRole("table").filter({ has: page.getByRole("rowheader", { name: "Mon" }) });
    await expect(heatmap.getByRole("rowheader")).toHaveCount(7);
    // At least one cell reports real sessions, so an all-blank grid cannot pass.
    await expect(page.getByTitle(/· [1-9]\d* sessions?/).first()).toBeAttached();
    await expect(page.getByText("The DC taper")).toBeVisible();
    expect(await page.locator(".recharts-line-curve").count()).toBeGreaterThan(0);
    await story.shot("heatmap and dc taper");
  });

  await step("where the money goes", async () => {
    await page.getByText("Where the money goes").scrollIntoViewIfNeeded();
    const byCost = page.getByRole("table").filter({ has: page.getByRole("columnheader", { name: "Spent" }) });
    await expect(byCost.getByRole("columnheader", { name: "Per kWh" })).toBeVisible();
    // Ranked by spend, so the first row is the most expensive place, not the busiest.
    await expect(byCost.getByRole("row")).not.toHaveCount(1);
    await story.shot("locations by spend");
  });
});
