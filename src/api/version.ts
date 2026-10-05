import { Hono } from "hono";
import type { Context } from "hono";
import type { UpdateRunDto, VersionInfoDto } from "@shared/api-types";
import type { AppEnv } from "../platform/env";
import { checkForUpdate, installConfigured, latestUpdateRun, readVersionInfo, triggerUpdateRun } from "../core/update";
import { isDemo } from "./demo";

/**
 * What version this instance is running, what the last update check found,
 * and — when a GitHub token is configured — the Install button behind it.
 *
 * Behind the session like everything else under /api/v1: which build a
 * self-hosted instance runs is nobody's business but its owner's, and a
 * signed-out visitor has no use for it.
 */

async function versionInfo(c: Context<{ Bindings: AppEnv }>): Promise<VersionInfoDto> {
  const info = await readVersionInfo(c.env.DB, c.env);
  // The demo is public and needs no password. It neither phones GitHub (the
  // cron skips it) nor nags a visitor about updating an instance that is not
  // theirs — so it reports the check as off rather than as never having run,
  // and never offers to install anything.
  return isDemo(c.env) ? { ...info, checkDisabled: true, canInstall: false } : info;
}

export const versionRoutes = new Hono<{ Bindings: AppEnv }>()
  .get("/version", async (c) => c.json(await versionInfo(c)))

  /**
   * "Check now", from the Settings page. Skips the once-a-day interval the cron
   * honours, because this one has a person waiting on it — and answers in the
   * same shape, so the page just replaces what it had.
   */
  .post("/version/check", async (c) =>
    c.json(isDemo(c.env) ? await versionInfo(c) : await checkForUpdate(c.env.DB, c.env, { force: true })),
  )

  /**
   * "Install it": dispatches the deploy workflow for the release the check
   * found. The instance keeps serving traffic; GitHub Actions builds the tag
   * and replaces the deployment from outside.
   */
  .post("/version/update", async (c) => {
    if (isDemo(c.env)) {
      return c.json({ error: "demo_mode", message: "This is a demo — there is nothing to update." }, 403);
    }
    if (!installConfigured(c.env)) {
      return c.json(
        { error: "not_configured", message: "No GitHub token is configured, so this instance cannot install itself." },
        409,
      );
    }
    const info = await readVersionInfo(c.env.DB, c.env);
    if (!info.updateAvailable || !info.latest) {
      return c.json({ error: "nothing_to_install", message: "No newer release is known." }, 409);
    }
    // The tag is reassembled from what the check stored, never taken from the
    // request: whoever holds a session may only install what the channel offers.
    const result = await triggerUpdateRun(c.env, `v${info.latest}-${info.channel}`);
    if (!result.ok) return c.json({ error: "dispatch_failed", message: result.message }, 502);
    return c.json({ started: true }, 202);
  })

  /** The deploy workflow's newest run, for the page to follow along with. */
  .get("/version/update/run", async (c) => {
    if (isDemo(c.env) || !installConfigured(c.env)) return c.json<UpdateRunDto | null>(null);
    return c.json<UpdateRunDto | null>(await latestUpdateRun(c.env));
  });
