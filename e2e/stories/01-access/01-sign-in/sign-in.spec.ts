import { CREDENTIALS } from "../../../harness/env";
import { expect, step, test } from "../../../harness/story";

/** See story.md — runs against the worker that has dev auto-login switched off. */
test("owner signs in and connects the Tesla account", async ({ page, story }) => {
  await step("the password screen is the front door", async () => {
    await story.goto(`${story.authUrl}/`);
    await expect(page.getByText("Enter the app password to continue.")).toBeVisible();
    await story.shot("password screen");
  });

  await step("a wrong password is refused", async () => {
    await page.getByLabel("Password").fill("not-the-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText("Wrong password.")).toBeVisible();
    await story.shot("wrong password");
  });

  await step("the right password reaches the Tesla connect screen", async () => {
    await page.getByLabel("Password").fill(CREDENTIALS.appPassword);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText("Connect your Tesla account")).toBeVisible();
    await story.shot("connect tesla");
  });

  await step("valid tokens land on the overview", async () => {
    await page.getByLabel("Access token").fill(CREDENTIALS.teslaAccessToken);
    await page.getByLabel("Refresh token").fill(CREDENTIALS.teslaRefreshToken);
    await page.getByRole("button", { name: "Sign in to Tesla" }).click();
    await expect(page.getByRole("link", { name: "Overview" })).toBeVisible();
    await expect(page.getByText(story.runtime.manifest.car.name)).toBeVisible();
    await story.shot("signed in overview");
  });

  // Connecting is what this story is about, so it has to hand the worker back
  // disconnected — otherwise the second viewport would start halfway through.
  await page.request.delete(`${story.authUrl}/api/v1/auth/tesla`);
});
