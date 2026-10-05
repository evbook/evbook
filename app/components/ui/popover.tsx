import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A button and the panel it opens under itself — the menus in the header and the
 * explanations behind an ⓘ. Closed by a click anywhere else, by Escape (which hands
 * focus back to the button), or by the content calling `close`, which is what a
 * menu item does once it has navigated.
 *
 * Positioned against its own wrapper rather than portalled: everything that opens
 * one sits in normal flow, and a panel that scrolls with its button is the right
 * behaviour for both.
 */
export function Popover({
  trigger,
  label,
  align = "start",
  side = "bottom",
  triggerClassName,
  panelClassName,
  className,
  children,
}: {
  trigger: ReactNode | ((open: boolean) => ReactNode);
  /** The button's accessible name, when its content does not give it one. */
  label?: string;
  align?: "start" | "end" | "center";
  side?: "bottom" | "top";
  triggerClassName?: string;
  panelClassName?: string;
  className?: string;
  children: ReactNode | ((close: () => void) => ReactNode);
}) {
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!wrapper.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const close = () => setOpen(false);

  return (
    <div ref={wrapper} className={cn("relative", className)}>
      <button
        ref={button}
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((o) => !o)}
        className={triggerClassName}
      >
        {typeof trigger === "function" ? trigger(open) : trigger}
      </button>
      {open && (
        <div
          id={id}
          className={cn(
            "evb-pop absolute z-50 min-w-48 rounded-xl border bg-popover p-1.5 text-popover-foreground shadow-overlay",
            side === "bottom" ? "top-full mt-2" : "bottom-full mb-2",
            align === "start" && "left-0",
            align === "end" && "right-0",
            align === "center" && "left-1/2 -translate-x-1/2",
            panelClassName,
          )}
        >
          {typeof children === "function" ? children(close) : children}
        </div>
      )}
    </div>
  );
}
