import { useState } from "react";
import { ArrowUpCircle, X } from "lucide-react";
import { Link } from "react-router";
import { useVersion } from "@/hooks/useAppSettings";
import { readDismissal, shouldOfferUpdate, writeDismissal } from "@/lib/updateNotice";
import { Button } from "@/components/ui/button";

/**
 * "There is a newer EVBook." Corner of the screen, dismissible, and — see
 * `lib/updateNotice.ts` — quiet for a week once it has been dismissed.
 *
 * It says what is available and where to read about it, and stops there. The
 * updating itself starts from the Version card in Settings, which "Update"
 * leads to: a notice in the corner is no place to confirm a deploy from.
 */
export function UpdateToast() {
  const { data } = useVersion();
  const [dismissed, setDismissed] = useState(false);
  // The stored dismissal and the clock it is measured against, both read once at
  // mount. Reading either during render would let what is on screen depend on
  // when React happened to re-render — and a week boundary crossed mid-session
  // would pop the notice up in the middle of reading a page.
  const [opened] = useState(() => ({ dismissal: readDismissal(window.localStorage), at: Date.now() }));

  const latest = data?.latest;
  if (dismissed || !latest || !shouldOfferUpdate(data, opened.dismissal, opened.at)) return null;

  return (
    <div
      // `status`, not `alert`: worth mentioning at the next natural pause,
      // not worth interrupting whatever is being read.
      role="status"
      aria-live="polite"
      className="fixed inset-x-4 bottom-4 z-50 mx-auto max-w-sm rounded-xl border bg-popover p-4 shadow-overlay sm:inset-x-auto sm:left-auto sm:right-6"
    >
      <div className="flex items-start gap-3">
        <ArrowUpCircle className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">EVBook {latest} is available</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            This instance runs {data?.current}. Your history is not touched by updating.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
            {data?.releaseUrl && (
              <a
                href={data.releaseUrl}
                target="_blank"
                rel="noreferrer"
                className="font-medium underline underline-offset-2"
              >
                What’s new
              </a>
            )}
            <Link to="/settings#version" className="font-medium underline underline-offset-2">
              Update
            </Link>
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          aria-label="Dismiss the update notice"
          className="-mr-2 -mt-2 size-8 shrink-0 p-0"
          onClick={() => {
            writeDismissal(window.localStorage, latest, Date.now());
            setDismissed(true);
          }}
        >
          <X className="size-4" aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}
