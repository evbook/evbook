import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * A modal over the native <dialog> element, in the kit's manner of styling the
 * platform's own control rather than rebuilding it (cf. select.tsx). Mounted
 * only while open, so there is exactly one way to be shown; the browser owns
 * focus trapping and the Escape key, and its `close` event — however caused —
 * is what tells the owner to drop `open`.
 */
function Dialog({
  open,
  onClose,
  className,
  children,
}: {
  open: boolean;
  onClose: () => void;
  className?: string;
  children: React.ReactNode;
}) {
  const ref = React.useRef<HTMLDialogElement>(null);

  React.useEffect(() => {
    if (open && !ref.current?.open) ref.current?.showModal();
  }, [open]);

  if (!open) return null;

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      className={cn(
        // `m-auto` restores the centring a modal <dialog> gets from the UA
        // stylesheet, which the CSS reset zeroes along with every other margin.
        "m-auto w-full max-w-sm rounded-xl border bg-popover p-6 text-popover-foreground shadow-overlay",
        "backdrop:bg-black/40 backdrop:backdrop-blur-sm",
        className,
      )}
    >
      {children}
    </dialog>
  );
}

export { Dialog };
