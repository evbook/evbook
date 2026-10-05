import { expect, step, test } from "../../../harness/story";

/**
 * See story.md. Runs against the live worker — the one with polling switched on,
 * so it writes as it goes and leaves the history worker's seeded data alone.
 */
test("owner sees live state and watches it change", async ({ page, story }) => {
  const card = page.getByRole("main");
  /*
    The state badge is a status region, which is what makes it addressable: the
    last-24-hours band names the same states in its legend, so plain text reading
    "Driving" means two things on this page — what the car is doing now, and what it
    did at some point yesterday. Matched on containment rather than equality, because
    the region also carries the car's name for a screen reader.
  */
  const state = page.getByRole("status");

  await step("the car is parked at home", async () => {
    await story.scenario("parked");
    await story.goto(`${story.liveUrl}/`);
    await expect(page.getByRole("heading", { name: "Fixture Bro" })).toBeVisible();
    await expect(card.getByText("Odometer")).toBeVisible();
    await expect(card.getByText(/%/).first()).toBeVisible();
    /*
      The firmware the car is on links to that release's notes on notateslaapp —
      what changed is not in this database and never will be, and noticing a new
      version is the moment you want to know. Built from what the row shows so it
      fails if the release and the link come apart: the car reports the version
      with a build hash after it, and only the version names a page.
    */
    const firmware = card.getByRole("link", { name: /^\d{4}\./ });
    const release = ((await firmware.textContent()) ?? "").trim().split(" ")[0];
    expect(release).toMatch(/^\d{4}(\.\d+)+$/);
    await expect(firmware).toHaveAttribute(
      "href",
      `https://www.notateslaapp.com/software-updates/version/${release}/release-notes`,
    );
    await story.shot("parked at home");
  });

  await step("what the car has been doing since yesterday", async () => {
    await expect(page.getByText("The last 24 hours")).toBeVisible();
    // The same band as History, over a fixed day, so "did it sleep last night" is
    // answerable without leaving the page you land on.
    await expect(page.getByRole("listitem").first()).toBeVisible();
    await story.shot("the last day", { fullPage: true });
  });

  await step("plugging in shows up as charging", async () => {
    await story.scenario("charging");
    await expect(state).toContainText("Charging", { timeout: 30_000 });
    await expect(card.getByText("Charger power")).toBeVisible();
    // Volts, amps and phases — recorded on every sample since the beginning, and
    // the difference between 11 kW on three phases and 11 kW on one.
    await expect(card.getByText("Supply")).toBeVisible();
    await story.shot("charging");
  });

  await step("driving shows speed and power", async () => {
    await story.scenario("driving");
    await expect(state).toContainText("Driving", { timeout: 30_000 });
    await expect(card.getByText("Speed")).toBeVisible();
    await story.shot("driving");
  });

  await step("parking again settles the card", async () => {
    await story.scenario("parked");
    await expect(state).not.toContainText("Driving", { timeout: 30_000 });
    await story.shot("parked again");
  });
});
