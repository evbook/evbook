import { expect, step, test } from "../../../harness/story";

/** See story.md. */
test("owner checks whether the car slept and how full it sat", async ({ page, story }) => {
  await step("the headline figures", async () => {
    await story.goto("/history");
    await expect(page.getByRole("heading", { name: "History" })).toBeVisible();
    await expect(page.getByText("Awake and idle")).toBeVisible();
    // A dash for the current state would mean no state row was left open. The
    // label is matched exactly because `getByText` is a case-insensitive
    // substring by default, and the timeline further down the page renders open
    // ranges as "… → now" — which matched too, as soon as the window happened to
    // contain one.
    await expect(page.getByText("Now", { exact: true }).locator("..")).not.toContainText("–");
    await story.shot("history headline");
  });

  await step("the state band", async () => {
    await expect(page.getByText("Where the time went")).toBeVisible();
    // The legend names every state present, so the band is readable without colour.
    await expect(page.getByRole("listitem").filter({ hasText: "Asleep" })).toBeVisible();
    await expect(page.getByRole("listitem").filter({ hasText: "Driving" })).toBeVisible();
    await story.shot("state band");
  });

  await step("the charge level", async () => {
    // Exact, so this is the card title and not the "Ø charge level" tile.
    await page.getByText("Charge level", { exact: true }).scrollIntoViewIfNeeded();
    // Area curves, not line curves: the levels are drawn with a gradient fill
    // under each line, and recharts classes the stroke by the mark that drew it.
    expect(await page.locator(".recharts-area-curve").count()).toBeGreaterThan(0);
    await expect(page.getByText("Lowest")).toBeVisible();
    await expect(page.getByText(/At or above 80 %/)).toBeVisible();
    await story.shot("charge level");
  });

  await step("narrow to today", async () => {
    await page.getByRole("button", { name: "1D", exact: true }).click();
    await expect(page).toHaveURL(/range=1d/);
    await expect(page.getByText(/Window: /)).toBeVisible();
    await expect(page.getByRole("listitem").first()).toBeVisible();
    await story.shot("today");
  });

  await step("step back to yesterday", async () => {
    await page.getByRole("button", { name: /^Previous day/ }).click();
    // Stepping off the present is what makes the forward arrow usable again.
    await expect(page.getByRole("button", { name: /^Next day/ })).toBeEnabled();
    await expect(page.getByText(/Window: /)).toBeVisible();
    await story.shot("yesterday");
  });

  await step("widen to the month", async () => {
    await page.getByRole("button", { name: "1M", exact: true }).click();
    await expect(page.getByText(/Averaged into /)).toBeVisible();
    await expect(page.getByRole("listitem").first()).toBeVisible();
    // The window ends in the future, so there is nothing ahead to step into.
    await expect(page.getByRole("button", { name: /^Next month/ })).toBeDisabled();
    await story.shot("this month", { fullPage: true });
  });

  /*
    Back a month before reading the log, and not for narrative reasons: the seeded
    history stops yesterday, so on the first of a month "this month" holds nothing and
    the log is legitimately empty. The previous month is always covered — the world
    generates ten weeks — so this is the window that makes the assertions below mean
    something on every day of the year rather than on twenty-eight of thirty.
  */
  await step("step back a month and read the timeline", async () => {
    await page.getByRole("button", { name: /^Previous month/ }).click();
    await expect(page.getByText(/Window: /)).toBeVisible();
    await page.getByText("Timeline", { exact: true }).scrollIntoViewIfNeeded();
    // The band above says a drive happened; only the log says which drive, where to
    // and what it cost.
    await expect(page.getByRole("cell", { name: "Drive" }).first()).toBeVisible();
    await expect(page.getByRole("cell", { name: "Asleep" }).first()).toBeVisible();
    await expect(page.getByText(/\d+ events/)).toBeVisible();
    await story.shot("timeline");
  });

  await step("follow a drive through to its own page", async () => {
    const rows = page.getByRole("row").filter({ has: page.getByRole("cell", { name: "Drive" }) });
    await rows.first().getByRole("link").click();
    await expect(page).toHaveURL(/\/drives\/\d+/);
    await story.shot("drive from the timeline");
    await page.goBack();
    await expect(page.getByText("Timeline", { exact: true })).toBeVisible();
  });

  await step("search the log for one place", async () => {
    await page.getByLabel("Search the timeline").fill("Home");
    await expect(page.getByRole("cell", { name: /Home/ }).first()).toBeVisible();
    // A sleep or offline span has no place to match, so it drops out of a search
    // rather than sitting in the results unfiltered.
    await expect(page.getByRole("cell", { name: "Asleep" })).toHaveCount(0);
    await story.shot("searched for home");
  });

  await step("hide the sleep and offline spans instead", async () => {
    await page.getByLabel("Search the timeline").fill("");
    await expect(page.getByRole("cell", { name: "Asleep" }).first()).toBeVisible();

    await page.getByRole("button", { name: "Asleep" }).click();
    await page.getByRole("button", { name: "Offline" }).click();
    // The narrowing is in the URL, so this view can be shared.
    await expect(page).toHaveURL(/kinds=drive%2Ccharge%2Cupdate/);
    await expect(page.getByRole("cell", { name: "Asleep" })).toHaveCount(0);
    await expect(page.getByRole("cell", { name: "Drive" }).first()).toBeVisible();
    await story.shot("only the events that moved something");
  });

  await step("widen to the year and read past the first chunk", async () => {
    // A year covers the whole seeded history whatever today's date is, so there is
    // always more than one chunk to page through.
    await page.getByRole("button", { name: "1Y", exact: true }).click();
    await expect(page.getByText(/^50 events so far$/)).toBeVisible();

    await page.getByRole("button", { name: "Load more" }).click();
    // The next chunk is appended to what was already read, not swapped in.
    await expect(page.getByText(/^50 events so far$/)).toBeHidden();
    await expect(page.getByText(/^(100 events so far|\d+ events)$/)).toBeVisible();
    await story.shot("the whole year, two chunks in");
  });

  await step("read what a firmware install actually changed", async () => {
    /*
      The version is the whole of what an update row says about itself, and what
      changed in it is not in this database and never will be. So it links out to
      notateslaapp's notes for that release. The year window covers both seeded
      updates, and the sleep and offline spans are still switched off from step 10,
      which is what keeps one of them inside the two chunks read so far.
    */
    const row = page
      .getByRole("row")
      .filter({ has: page.getByRole("cell", { name: "Update" }) })
      .first();
    await row.scrollIntoViewIfNeeded();
    const link = row.getByRole("link");
    // Built from what the row shows, so this fails if the release and the link ever
    // come apart — the car reports "2026.14.3 f9a1c2b" and only the first half of
    // that names a page.
    const shown = ((await link.textContent()) ?? "").trim();
    const release = shown.split(" ")[0];
    expect(release).toMatch(/^\d{4}(\.\d+)+$/);
    await expect(link).toHaveAttribute(
      "href",
      `https://www.notateslaapp.com/software-updates/version/${release}/release-notes`,
    );
    // Off-site: the log keeps its place rather than being navigated away from.
    await expect(link).toHaveAttribute("target", "_blank");
    await story.shot("a firmware install and its release notes");
  });
});
