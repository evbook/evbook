import { startBroker, type Broker } from "../../../../test/mqtt-broker";
import { expect, step, test } from "../../../harness/story";

/**
 * See story.md. The broker is the test suite's own (test/mqtt-broker.ts), on a
 * free port of this machine, so the app server it connects to is the real one
 * and nothing reaches the network. The story turns MQTT off and clears it at
 * the end.
 */
test("owner sends the car's values to an MQTT broker", async ({ page, story }) => {
  const broker: Broker = await startBroker();
  try {
    // The card: the nearest box around both its title and its first field.
    const card = page.getByText("MQTT", { exact: true }).locator("xpath=ancestor::div[.//label[text()='Broker']][1]");

    await step("the MQTT card", async () => {
      await story.goto("/settings");
      await page.getByText("MQTT", { exact: true }).scrollIntoViewIfNeeded();
      await expect(page.getByText("Enter the broker below and save, then turn this on.")).toBeVisible();
      await story.shot("mqtt off");
    });

    await step("a login in the address is refused", async () => {
      await page.getByLabel("Broker").fill("mqtt://evbook:secret@192.168.1.10:1883");
      await page.getByRole("button", { name: "Save" }).click();
      await expect(page.getByText("Put the user name and password in their own fields")).toBeVisible();
    });

    await step("enter the broker and the login", async () => {
      await page.getByLabel("Broker").fill(broker.url);
      await page.getByLabel("User name").fill("evbook");
      await page.getByLabel("Password").fill("broker-password");
      await page.getByRole("button", { name: "Save" }).click();
      await expect(page.getByText("Stored, encrypted. Type a new one to replace it.")).toBeVisible();
      await expect(page.getByLabel("Password")).toHaveValue("");
    });

    await step("turn it on", async () => {
      await page.getByLabel("Publish to MQTT").click();
      await expect.poll(() => broker.retained.get("evbook/status"), { timeout: 15_000 }).toBe("online");
      await expect(card.getByText("Connected", { exact: true })).toBeVisible({ timeout: 15_000 });
      expect(broker.connects.at(-1)).toMatchObject({ username: "evbook", password: "broker-password" });
      await story.shot("mqtt connected");
    });

    await step("turn it off and clear it", async () => {
      await page.getByLabel("Publish to MQTT").click();
      await expect(page.getByLabel("Publish to MQTT")).not.toBeChecked();
      await expect.poll(() => broker.retained.get("evbook/status")).toBe("offline");
    });
  } finally {
    // Nothing stored, as the seed had it, also when a step failed: the card
    // offers no "forget the password", the API does.
    await page.request.put("/api/v1/mqtt", {
      data: { enabled: false, url: "", username: "", password: null, prefix: "evbook" },
    });
    await broker.close();
  }
});
