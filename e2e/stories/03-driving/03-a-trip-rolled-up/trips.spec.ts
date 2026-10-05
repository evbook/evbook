import { expect, step, test } from "../../../harness/story";

/**
 * See story.md.
 *
 * Nothing here asserts a drive count or a distance for the journey. The seeded
 * history is anchored to the seed moment, so which weekday the trip lands on moves
 * from run to run — the journey itself is fixed, what surrounds it is not.
 */
test("owner looks back at how the road trip went", async ({ page, story }) => {
  await step("the journeys of the last year", async () => {
    await story.goto("/trips?range=1y");
    await expect(page.getByRole("heading", { name: "Trips" })).toBeVisible();
    // The rule is on the page, because a list a heuristic produced has to say so.
    await expect(page.getByText(/A trip is 2 or more drives covering at least 60 km/)).toBeVisible();
    await story.shot("the trip list");
  });

  await step("what the journeys came to", async () => {
    await expect(page.getByText("Share of the distance")).toBeVisible();
    await expect(page.getByText("Distance on trips")).toBeVisible();
    // The everyday driving is named as such, rather than silently missing.
    await expect(page.getByText(/was everyday driving/)).toBeVisible();
    await story.shot("trip totals");
  });

  await step("open the journey", async () => {
    const trip = page.getByRole("button", { expanded: false }).filter({ hasText: "Leipzig" });
    await trip.click();
    // The map and the band are the drives list's route and the History page's
    // state timeline, both pointed at this journey's window.
    await expect(page.locator(".leaflet-container")).toBeVisible();
    await expect(page.getByText("Where the time went")).toBeVisible();
    await expect(page).toHaveURL(/[?&]trip=\d+/);
    await story.shot("the journey opened", { fullPage: true });
  });

  await step("the itinerary, stop by stop", async () => {
    // Legs and stops interleaved on one rail, not a table of parkings: the drives
    // between the stops are part of the journey too.
    const itinerary = page.getByRole("list", { name: "The journey, stop by stop" });
    await itinerary.scrollIntoViewIfNeeded();
    await expect(itinerary.getByText(/Leipzig/).first()).toBeVisible();
    await expect(itinerary.getByText(/stayed/).first()).toBeVisible();
    await expect(itinerary.getByText(/drive ·/).first()).toBeVisible();
    // The journey's own edges, told apart from the stops inside it.
    await expect(itinerary.getByText(/left /)).toBeVisible();
    await expect(itinerary.getByText(/arrived /)).toBeVisible();
    // The pack's low point over the whole journey, which no single row would give.
    await expect(page.getByText("Lowest it got")).toBeVisible();
    await story.shot("the stops");
  });

  await step("close it again", async () => {
    await page.getByRole("button", { expanded: true }).click();
    await expect(page.locator(".leaflet-container")).toHaveCount(0);
    await expect(page).not.toHaveURL(/[?&]trip=/);
    await story.shot("back to the list");
  });
});
