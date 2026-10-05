import { expect, step, test } from "../../../harness/story";

/**
 * See story.md. Runs against the live worker, whose poll loop is what notices
 * the mock car changing state — the same path a real car's wake takes.
 */
test("owner wakes the car and sends it a destination", async ({ page, story }) => {
  const card = page.getByRole("main");
  const state = page.getByRole("status");

  await step("the card starts online with diagnostics folded away", async () => {
    await story.scenario("parked");
    await story.goto(`${story.liveUrl}/`);
    await expect(state).toContainText("Online", { timeout: 30_000 });
    await expect(card.getByRole("button", { name: "Diagnostics" })).toBeVisible();
    await expect(card.getByText("Tyre pressure")).not.toBeVisible();
    await story.shot("online and folded");
  });

  await step("diagnostics expand into the readings", async () => {
    await card.getByRole("button", { name: "Diagnostics" }).click();
    await expect(card.getByText("Tyre pressure")).toBeVisible();
    await expect(card.getByText("Doors")).toBeVisible();
    await expect(card.getByText("Windows")).toBeVisible();
    await expect(card.getByText("Dashcam")).toBeVisible();
    await story.shot("diagnostics open", { fullPage: true });
  });

  await step("a sleeping car offers Wake and refuses Navigate", async () => {
    await story.scenario("asleep");
    await expect(state).toContainText("Asleep", { timeout: 60_000 });
    await expect(card.getByRole("button", { name: "Wake" })).toBeVisible();
    await expect(card.getByRole("button", { name: "Navigate" })).toBeDisabled();
    // The readings survive the car sleeping — last known, said out loud.
    await expect(card.getByText(/Last reading .* ago/)).toBeVisible();
    await story.shot("asleep with wake");
  });

  await step("wake brings it back online", async () => {
    await card.getByRole("button", { name: "Wake" }).click();
    await expect(state).toContainText("Online", { timeout: 60_000 });
    await story.shot("awake again");
  });

  await step("a destination lands in the car's navigation", async () => {
    await card.getByRole("button", { name: "Navigate" }).click();
    await page.getByLabel("Destination").fill("Berliner Str. 1, Berlin");
    await page.getByRole("button", { name: "Send to car" }).click();
    await expect(page.getByLabel("Destination")).not.toBeVisible();
    const mockState = (await (await page.request.get(`${story.runtime.mockUrl}/__mock/state`)).json()) as {
      lastDestination: string | null;
    };
    expect(mockState.lastDestination).toBe("Berliner Str. 1, Berlin");
    await story.shot("destination sent");
  });
});
