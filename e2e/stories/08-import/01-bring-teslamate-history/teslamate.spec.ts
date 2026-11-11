import { expect, step, test } from "../../../harness/story";
import { OLD_DUMP, OLD_VIN } from "../../../../test/teslamate-dump";

/**
 * See story.md. This story writes, and cleans up after itself by deleting the
 * import it made, so the car's history is what the other stories see. (The one
 * address the backup carried stays: addresses are shared, not history.)
 */

/** The seeded car's VIN (e2e/mocks/world.mjs), so the backup lands on it. */
const SEEDED_VIN = "5YJ3E1EB6KF999999";

test("a TeslaMate user brings their history and can take it back out", async ({ page, story }) => {
  const records = page.getByTestId("import-record");

  await step("the import page", async () => {
    await story.goto("/import");
    await expect(page.getByRole("heading", { name: "Import history" })).toBeVisible();
    await expect(page.getByText("docker compose exec -T database pg_dump")).toBeVisible();
    await story.shot("import page");
  });

  await step("pick the TeslaMate backup", async () => {
    await page.getByLabel("Export file").setInputFiles({
      name: "teslamate.bck",
      mimeType: "application/octet-stream",
      buffer: Buffer.from(OLD_DUMP.replaceAll(OLD_VIN, SEEDED_VIN)),
    });
    // Scoped to the picker's card: a finished import from an earlier run shows the VIN too.
    const picker = page
      .locator("div")
      .filter({ has: page.getByText("Choose an export") })
      .filter({ has: page.getByLabel("Export file") })
      .last();
    await expect(picker.getByText("TeslaMate", { exact: true })).toBeVisible();
    await expect(picker.getByText(SEEDED_VIN)).toBeVisible();
    await story.shot("backup recognised");
  });

  await step("start the import", async () => {
    await page.getByRole("button", { name: "Start import" }).click();
    await expect(page.getByText("Import finished")).toBeVisible({ timeout: 30_000 });
    await story.shot("import finished");
  });

  await step("the import on record", async () => {
    await expect(records).toHaveCount(1);
    await expect(records.first()).toContainText("1 drives, 1 charges, 3 positions");
    await records.first().scrollIntoViewIfNeeded();
    await story.shot("imported backups");
  });

  await step("delete it again", async () => {
    await records.first().getByRole("button", { name: "Delete" }).click();
    await records.first().getByRole("button", { name: "Confirm" }).click();
    await expect(records).toHaveCount(0);
    await story.shot("import deleted");
  });
});
