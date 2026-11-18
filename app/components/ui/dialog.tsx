import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * A modal over the native <dialog> element, in the kit's manner of styling the
 * platform's own control rather than rebuilding it (cf. select.tsx). Mounted
 * only while open, so there is exactly one way to be shown; the browser owns
 * focus trapping and the Escape key, and its `close` event — however caused —
 * is what tells the owner to drop `open`.
 *
 * A tap on the backdrop closes it too. The platform does not do that for a
 * modal dialog (`closedby="any"` is too new to rely on), and on a phone, where
 * there is no Escape key, the backdrop is the obvious way out of a sheet. A tap
 * on the backdrop lands on the <dialog> itself, as does one on its padding, so
 * the point is checked against the box. Both the press and the release must be
 * outside it, so a drag that starts in a field and ends past the edge does not
 * throw the dialog away.
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
  const pressedOutside = React.useRef(false);

  React.useEffect(() => {
    if (open && !ref.current?.open) ref.current?.showModal();
  }, [open]);

  if (!open) return null;

  const outside = (event: React.MouseEvent<HTMLDialogElement>) => {
    if (event.target !== event.currentTarget) return false;
    const box = event.currentTarget.getBoundingClientRect();
    return (
      event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom
    );
  };

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onPointerDown={(event) => {
        pressedOutside.current = outside(event);
      }}
      onClick={(event) => {
        if (pressedOutside.current && outside(event)) event.currentTarget.close();
        pressedOutside.current = false;
      }}
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
