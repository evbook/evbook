import { z } from "zod";
import type { UpdateRunDto, VersionInfoDto } from "@shared/api-types";
import {
  APP_VERSION,
  DEFAULT_CHANNEL,
  RELEASE_REPO,
  compareVersions,
  isReleaseChannel,
  parseReleaseTag,
  pickLatestRelease,
  releaseTagUrl,
  type ReleaseChannel,
} from "@shared/version";
import type { AppConfig } from "../platform/env";
import type { SqlDatabase } from "../platform/ports";

/**
 * "Is there a newer EVBook?", asked of the repository's tag list.
 *
 * Asked by the instance, once a day, from the cron — not by the browser. One
 * instance then asks once no matter how many tabs and phones are pointed at it,
 * the answer survives a reload, and GitHub is never told the IP of everyone who
 * opens the app. With no token configured it is one unauthenticated request a
 * day against a limit of sixty an hour; with `UPDATE_GITHUB_TOKEN` set the
 * request is authenticated, which is what makes a *private* release repo
 * readable at all (GitHub answers an anonymous request about one with 404).
 *
 * Nothing here installs anything. Updating a self-hosted app means pulling the
 * new build the way it was deployed, which this process has no business doing
 * to itself; all it does is notice, and say so.
 */

const DEFAULT_API_HOST = "https://api.github.com";

/** How long an answer is kept before the cron asks again. */
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Long enough for a slow answer, short enough not to sit inside the cron. */
const REQUEST_TIMEOUT_MS = 8_000;

/** GitHub's maximum page. More tags than this and the oldest fall off, not the newest. */
const TAG_PAGE_SIZE = 100;

/** `commit` is optional so that a listing without it still names the release. */
const TagList = z.array(z.object({ name: z.string(), commit: z.object({ sha: z.string() }).optional() }));

const CommitInfo = z.object({ commit: z.object({ committer: z.object({ date: z.string() }) }) });

/** How much of a commit hash is shown: what `git rev-parse --short` prints. */
const SHORT_REVISION = 7;

/**
 * Everything the version endpoint reports except where the instance runs,
 * which is the entrypoint's to say (src/api/version.ts adds it).
 */
export type UpdateInfo = Omit<VersionInfoDto, "platform">;

type UpdateConfig = Pick<
  AppConfig,
  "GITHUB_API_HOST" | "UPDATE_CHANNEL" | "DISABLE_UPDATE_CHECK" | "UPDATE_REPO" | "UPDATE_GITHUB_TOKEN"
>;

interface UpdateRow {
  update_checked_at: number | null;
  update_latest_tag: string | null;
  update_latest_sha: string | null;
  update_latest_at: number | null;
}

/** The channel this instance follows; an unknown name falls back rather than failing. */
function updateChannel(config: UpdateConfig): ReleaseChannel {
  return isReleaseChannel(config.UPDATE_CHANNEL) ? config.UPDATE_CHANNEL : DEFAULT_CHANNEL;
}

/** An instance that would rather not talk to GitHub at all. */
function updateCheckDisabled(config: UpdateConfig): boolean {
  return config.DISABLE_UPDATE_CHECK === "true";
}

/**
 * What is known right now, without asking anybody. This is what the API serves
 * and what the toast is decided from.
 */
export async function readVersionInfo(db: SqlDatabase, config: UpdateConfig): Promise<UpdateInfo> {
  const row = await db
    .prepare(
      "SELECT update_checked_at, update_latest_tag, update_latest_sha, update_latest_at FROM settings WHERE id = 1",
    )
    .first<UpdateRow>();
  const channel = updateChannel(config);
  // Parsed rather than trusted: the stored tag belongs to whichever channel was
  // being followed when it was written, and an instance that has since switched
  // must not be shown the other channel's version.
  const release = row?.update_latest_tag ? parseReleaseTag(row.update_latest_tag) : null;
  // Nor is one that has stopped asking shown what it once heard: with the
  // check off there is no telling whether that is still the newest.
  const disabled = updateCheckDisabled(config);
  const latest = !disabled && release && release.channel === channel ? release : null;
  return {
    current: APP_VERSION,
    channel,
    latest: latest?.version ?? null,
    releaseUrl: latest ? releaseTagUrl(latest.tag) : null,
    latestRevision: latest ? (row?.update_latest_sha?.slice(0, SHORT_REVISION) ?? null) : null,
    latestCommittedAt: latest ? (row?.update_latest_at ?? null) : null,
    checkedAt: row?.update_checked_at ?? null,
    updateAvailable: latest !== null && compareVersions(latest.version, APP_VERSION) > 0,
    checkDisabled: disabled,
    canInstall: installConfigured(config),
  };
}

/**
 * Ask GitHub, unless the last answer is still fresh — `force` is the Settings
 * page's "Check now", which is a person waiting for a reply and so skips the
 * interval.
 *
 * A failed check still stamps the clock. The alternative is an instance with no
 * network hammering a rate-limited API every ten minutes, and the thing being
 * missed is a notice that can wait until tomorrow.
 */
export async function checkForUpdate(
  db: SqlDatabase,
  config: UpdateConfig,
  options: { force?: boolean; now?: number } = {},
): Promise<UpdateInfo> {
  const before = await readVersionInfo(db, config);
  if (before.checkDisabled) return before;

  const now = options.now ?? Date.now();
  if (!options.force && before.checkedAt !== null && now - before.checkedAt < CHECK_INTERVAL_MS) return before;

  const release = await fetchLatestRelease(config, before.channel);
  if (!release) {
    // Nothing learned: the last known release is kept rather than cleared,
    // because a dead network is no reason to tell someone they are up to date.
    await db.prepare("UPDATE settings SET update_checked_at = ? WHERE id = 1").bind(now).run();
    return readVersionInfo(db, config);
  }

  const known = await db
    .prepare("SELECT update_latest_tag, update_latest_sha, update_latest_at FROM settings WHERE id = 1")
    .first<UpdateRow>();
  const sameTag = known?.update_latest_tag === release.tag;
  const sha = release.sha ?? (sameTag ? (known?.update_latest_sha ?? null) : null);
  // The date is asked for once per release, not once per check: it is kept for
  // as long as the tag still points at the commit it was read from.
  let committedAt = sameTag && known?.update_latest_sha === sha ? (known?.update_latest_at ?? null) : null;
  if (committedAt === null && sha) committedAt = await fetchCommitDate(config, sha);

  await db
    .prepare(
      "UPDATE settings SET update_checked_at = ?, update_latest_tag = ?, update_latest_sha = ?, update_latest_at = ? WHERE id = 1",
    )
    .bind(now, release.tag, sha, committedAt)
    .run();
  return readVersionInfo(db, config);
}

/** GitHub asks for both of these; the token only when the caller holds one. */
function githubHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    // GitHub rejects an unidentified client outright.
    "user-agent": `EVBook/${APP_VERSION}`,
  };
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

/**
 * Reads something from the release repo, or null if it could not be read —
 * offline, blocked, rate-limited, timed out and "not the JSON expected" are all
 * the same answer to a check that can simply ask again tomorrow.
 *
 * Asked with the install token when there is one — a private release repo is
 * invisible without it. If the authenticated ask fails (a token that expired,
 * say), it is retried anonymously rather than going blind: for a public repo
 * that is exactly the request that always worked.
 */
async function readReleaseRepo<T>(config: UpdateConfig, path: string, shape: z.ZodType<T>): Promise<T | null> {
  const host = config.GITHUB_API_HOST || DEFAULT_API_HOST;
  const url = `${host}/repos/${RELEASE_REPO}${path}`;
  try {
    let response = await fetch(url, {
      headers: githubHeaders(config.UPDATE_GITHUB_TOKEN),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok && config.UPDATE_GITHUB_TOKEN) {
      console.warn(`[update] ${path} answered ${response.status} with the token; retrying without`);
      response = await fetch(url, {
        headers: githubHeaders(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    }
    if (!response.ok) {
      console.warn(`[update] ${path} answered ${response.status}`);
      return null;
    }
    const parsed = shape.safeParse(await response.json());
    if (!parsed.success) {
      console.warn(`[update] ${path} was not the shape expected`);
      return null;
    }
    return parsed.data;
  } catch (error) {
    console.warn(`[update] ${path} failed:`, error);
    return null;
  }
}

/**
 * The newest tag on the channel and the commit it points at, or null if the
 * listing could not be read or holds no release for this channel.
 */
async function fetchLatestRelease(
  config: UpdateConfig,
  channel: ReleaseChannel,
): Promise<{ tag: string; sha: string | null } | null> {
  const tags = await readReleaseRepo(config, `/tags?per_page=${TAG_PAGE_SIZE}`, TagList);
  if (!tags) return null;
  const latest = pickLatestRelease(
    tags.map((entry) => entry.name),
    channel,
  );
  if (!latest) return null;
  return { tag: latest.tag, sha: tags.find((entry) => entry.name === latest.tag)?.commit?.sha ?? null };
}

/**
 * When a commit was made — the one thing about a release the tag listing does
 * not say. Null when it could not be read; the next check asks again.
 */
async function fetchCommitDate(config: UpdateConfig, sha: string): Promise<number | null> {
  const commit = await readReleaseRepo(config, `/commits/${sha}`, CommitInfo);
  const at = commit ? Date.parse(commit.commit.committer.date) : NaN;
  return Number.isFinite(at) ? at : null;
}

/**
 * Installing the update, not just noticing it: with a GitHub token configured,
 * "Install" dispatches the repository's deploy workflow for the release tag.
 * The dangerous work — building, migrating, uploading — happens in Actions,
 * outside the process being replaced; a worker that tried to redeploy itself
 * and failed half-way would have broken the only thing able to fix it.
 */

/** The workflow the Install button dispatches (.github/workflows/deploy.yml). */
const DEPLOY_WORKFLOW = "deploy.yml";

/** Which repository's workflow deploys this instance — a fork deploys from itself. */
function installRepo(config: UpdateConfig): string {
  return config.UPDATE_REPO || RELEASE_REPO;
}

/**
 * What a refusal is most likely about when the instance was never told which
 * repository deploys it: the token is for the owner's fork, and the request
 * went to the release repo. A deploy from a checkout that was never told about
 * the fork (cloudflare.config.ts `updateRepo`) sets UPDATE_REPO to nothing; the
 * fork's own workflow always sets it.
 */
function unsetRepoHint(config: UpdateConfig): string {
  if (config.UPDATE_REPO) return "";
  return ` UPDATE_REPO is not set, so this was asked of ${RELEASE_REPO}. If you deploy from a fork, run its deploy workflow once: that sets it.`;
}

/** An Install button only exists once a token able to dispatch is configured. */
export function installConfigured(config: UpdateConfig): boolean {
  return Boolean(config.UPDATE_GITHUB_TOKEN);
}

function githubRequest(config: UpdateConfig, path: string, init: RequestInit = {}): Promise<Response> {
  const host = config.GITHUB_API_HOST || DEFAULT_API_HOST;
  return fetch(`${host}${path}`, {
    ...init,
    headers: { ...githubHeaders(config.UPDATE_GITHUB_TOKEN), ...init.headers },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

const RepoInfo = z.object({ default_branch: z.string() });

const RunList = z.object({
  workflow_runs: z.array(
    z.object({
      status: z.string(),
      conclusion: z.string().nullable(),
      html_url: z.string(),
      run_started_at: z.string().nullable().optional(),
      created_at: z.string(),
    }),
  ),
});

/**
 * Dispatches the deploy workflow for `tag`. The dispatch ref is the default
 * branch — where the workflow file lives — and the tag rides in as an input,
 * so a release cut before the workflow existed can still be installed.
 */
export async function triggerUpdateRun(
  config: UpdateConfig,
  tag: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const repo = installRepo(config);
  try {
    const repoResponse = await githubRequest(config, `/repos/${repo}`);
    if (!repoResponse.ok) {
      return {
        ok: false,
        message: `GitHub answered ${repoResponse.status} for ${repo} — check UPDATE_REPO and the token.${unsetRepoHint(config)}`,
      };
    }
    const repoInfo = RepoInfo.safeParse(await repoResponse.json());
    const ref = repoInfo.success ? repoInfo.data.default_branch : "main";

    const dispatch = await githubRequest(config, `/repos/${repo}/actions/workflows/${DEPLOY_WORKFLOW}/dispatches`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ref, inputs: { tag } }),
    });
    // 204 is the only success GitHub sends for a dispatch.
    if (dispatch.status === 204) return { ok: true };
    const body = (await dispatch.json().catch(() => null)) as { message?: string } | null;
    return {
      ok: false,
      message:
        (body?.message
          ? `GitHub refused the dispatch: ${body.message}.`
          : `GitHub answered ${dispatch.status} to the dispatch.`) + unsetRepoHint(config),
    };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The newest run of the deploy workflow, or null when there is none (or
 * GitHub could not be asked — the button's polling treats both as "nothing to
 * show yet" rather than an error worth a banner).
 */
export async function latestUpdateRun(config: UpdateConfig): Promise<UpdateRunDto | null> {
  const repo = installRepo(config);
  try {
    const response = await githubRequest(config, `/repos/${repo}/actions/workflows/${DEPLOY_WORKFLOW}/runs?per_page=1`);
    if (!response.ok) {
      console.warn(`[update] run listing answered ${response.status}`);
      return null;
    }
    const parsed = RunList.safeParse(await response.json());
    if (!parsed.success) {
      console.warn("[update] run listing was not the shape expected");
      return null;
    }
    const run = parsed.data.workflow_runs[0];
    if (!run) return null;
    return {
      status: run.status,
      conclusion: run.conclusion,
      url: run.html_url,
      startedAt: Date.parse(run.run_started_at ?? run.created_at),
    };
  } catch (error) {
    console.warn("[update] run listing failed:", error);
    return null;
  }
}
