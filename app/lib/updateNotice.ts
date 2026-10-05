import type { VersionInfoDto } from "@shared/api-types";

/**
 * When to mention that there is a newer EVBook, and — the part that matters —
 * when to shut up about it.
 *
 * An update notice on a logger nobody is waiting on is not urgent, and a banner
 * that comes back on every page load is how a notice gets ignored for good. So
 * "Later" means a week, per version: dismissing 0.2.0 dismisses 0.2.0, and 0.3.0
 * arriving is new information that gets to say so once.
 *
 * The record is per browser, in localStorage, because that is where "I have seen
 * this" belongs — dismissing it on a phone should not decide what a laptop shows,
 * and it is not something worth a row in the database.
 */

/** How long a dismissed version stays quiet before asking once more. */
export const REMIND_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

const STORAGE_KEY = "evbook.update-dismissed";

export interface UpdateDismissal {
  version: string;
  at: number;
}

/** Only the two methods this needs, so a spec can pass a plain object. */
export type DismissalStore = Pick<Storage, "getItem" | "setItem">;

/**
 * localStorage throws rather than returning null in a browser that has storage
 * switched off, and a private window is not a reason to fail to render — so a
 * store that cannot be read is treated as one that holds nothing.
 */
export function readDismissal(store: DismissalStore): UpdateDismissal | null {
  try {
    const raw = store.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { version, at } = parsed as Partial<UpdateDismissal>;
    return typeof version === "string" && typeof at === "number" ? { version, at } : null;
  } catch {
    return null;
  }
}

export function writeDismissal(store: DismissalStore, version: string, now: number): void {
  try {
    store.setItem(STORAGE_KEY, JSON.stringify({ version, at: now } satisfies UpdateDismissal));
  } catch {
    // Storage refused. The notice comes back on the next load, which is a worse
    // outcome than remembering, and a better one than a blank screen.
  }
}

/** Whether to put the notice on screen at all. */
export function shouldOfferUpdate(
  info: VersionInfoDto | undefined,
  dismissal: UpdateDismissal | null,
  now: number,
): boolean {
  if (!info?.updateAvailable || !info.latest) return false;
  if (!dismissal) return true;
  // A version the reader has not seen mentioned before gets to interrupt once,
  // however recently they waved the last one away.
  if (dismissal.version !== info.latest) return true;
  return now - dismissal.at >= REMIND_AFTER_MS;
}
