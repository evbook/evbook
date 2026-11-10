import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { resetCar } from "../test/db";
import worker from "./index";

/**
 * The cron half of the polling clock. Cars that are parked or asleep run with no
 * Durable Object alarm armed — an armed alarm keeps the object resident, which is
 * what Durable Objects bill — so the cron is what comes round to poll them, and it
 * decides who is due by reading `cars.next_due_at` rather than by waking anything.
 *
 * A poll always ends by rescheduling, whatever the Owner API says, so a deadline that
 * moved is the tell that the car was polled. These specs read only that, and never
 * touch AuthDO: it is the one Durable Object shared with the other spec files, and
 * the pool invalidates an instance the moment a second file reaches for it.
 */

const CAR_ID = 45;

function tick(minute = 1): Promise<void> {
  const at = new Date(Date.UTC(2026, 0, 1, 12, minute));
  const controller = {
    scheduledTime: at.getTime(),
    cron: "* * * * *",
    noRetry() {},
  } as ScheduledController;
  // The handler takes no ExecutionContext — it awaits everything it starts.
  return worker.scheduled(controller, env);
}

async function setDue(at: number | null): Promise<void> {
  await env.DB.prepare("UPDATE cars SET next_due_at = ? WHERE id = ?").bind(at, CAR_ID).run();
}

async function due(): Promise<number | null> {
  const row = await env.DB.prepare("SELECT next_due_at FROM cars WHERE id = ?")
    .bind(CAR_ID)
    .first<{ next_due_at: number | null }>();
  return row?.next_due_at ?? null;
}

describe("cron polling clock", () => {
  beforeEach(() => resetCar(CAR_ID));

  it("polls a car whose deadline has come round", async () => {
    await setDue(Date.now() - 1_000);
    await tick();
    expect((await due())!).toBeGreaterThan(Date.now());
  });

  it("polls a car that has never been scheduled", async () => {
    await setDue(null);
    await tick();
    expect(await due()).not.toBeNull();
  });

  it("leaves a car alone until its deadline is close", async () => {
    const at = Date.now() + 10 * 60_000;
    await setDue(at);
    await tick();
    expect(await due()).toBe(at);
  });

  it("polls a deadline that lands inside the next period rather than letting it slip", async () => {
    // Without the half-period of slack this one waits for the run after next,
    // which turns a 60 s cadence into 120 s.
    const at = Date.now() + 20_000;
    await setDue(at);
    await tick();
    expect(await due()).not.toBe(at);
  });

  it("takes a disabled car off the clock", async () => {
    await env.DB.prepare("UPDATE car_settings SET enabled = 0 WHERE car_id = ?").bind(CAR_ID).run();
    await setDue(Date.now() - 1_000);
    await tick();
    expect(await due()).toBeNull();
  });
});
