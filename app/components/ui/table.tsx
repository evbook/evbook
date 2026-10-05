import * as React from "react";
import { ChevronRight } from "lucide-react";
import { Link, useNavigate } from "react-router";
import { cn } from "@/lib/utils";

/**
 * Tables scroll horizontally inside their own container on narrow screens.
 *
 * The container is focusable and labelled, because a scroll region that only a mouse
 * or a finger can move is a region a keyboard user cannot read the right-hand end of.
 * It mattered as soon as a table arrived with no links in it — the earlier ones all
 * had a "Details" link per row, which gave the keyboard something to travel along and
 * scrolled the region as a side effect.
 */
function Table({ className, label, ...props }: React.ComponentProps<"table"> & { label?: string }) {
  return (
    <div
      className="relative w-full overflow-x-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      tabIndex={0}
      role="region"
      aria-label={label ?? "Table, scrolls sideways"}
    >
      <table className={cn("w-full caption-bottom text-sm", className)} {...props} />
    </div>
  );
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return <thead className={cn("[&_tr]:border-b [&_tr]:hover:bg-transparent", className)} {...props} />;
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return <tbody className={cn("[&_tr:last-child]:border-0", className)} {...props} />;
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return <tr className={cn("border-b transition-colors hover:bg-muted/40", className)} {...props} />;
}

/**
 * A row that is one thing with a page of its own — a drive, a charge — and so is
 * clickable across its whole width rather than only on its date. The links inside
 * stay the real way in: a keyboard tabs to them, a screen reader lists them, and a
 * click that lands on one is left to it. ⌘/Ctrl-click opens the page in a new tab,
 * the way it would on the link.
 */
function TableRowLink({ to, className, ...props }: React.ComponentProps<"tr"> & { to: string }) {
  const navigate = useNavigate();
  return (
    <tr
      className={cn("group/row cursor-pointer border-b transition-colors hover:bg-muted/50", className)}
      onClick={(event) => {
        if ((event.target as HTMLElement).closest("a, button, input, select, label")) return;
        if (window.getSelection()?.toString()) return;
        if (event.metaKey || event.ctrlKey) window.open(to, "_blank", "noopener");
        else void navigate(to, { viewTransition: true });
      }}
      {...props}
    />
  );
}

/** The row's own link, at its end: a chevron that brightens as the row is hovered. */
function RowChevron({ to, label = "Details" }: { to: string; label?: string }) {
  return (
    <Link
      to={to}
      viewTransition
      aria-label={label}
      className="inline-grid size-7 place-items-center rounded-full text-muted-foreground/50 transition-colors group-hover/row:bg-foreground/5 group-hover/row:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <ChevronRight className="size-4" aria-hidden="true" />
    </Link>
  );
}

function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      className={cn(
        "h-10 whitespace-nowrap px-3 text-left align-middle text-xs font-medium text-muted-foreground first:pl-5 last:pr-5",
        className,
      )}
      {...props}
    />
  );
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return <td className={cn("whitespace-nowrap px-3 py-3 align-middle first:pl-5 last:pr-5", className)} {...props} />;
}

export { Table, TableHeader, TableBody, TableRow, TableRowLink, RowChevron, TableHead, TableCell };
