import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The top of every page: the title, one line under it, and whatever acts on the
 * whole page on the right. One shape everywhere, so moving between sections feels
 * like turning pages of one book rather than opening different documents.
 *
 * The line under the title is a line. Anything longer — how a figure is measured,
 * why a chart is drawn the way it is — goes in `info`, behind an ⓘ beside the
 * title, where it is one tap away instead of in the way.
 */
export function PageHeader({
  title,
  description,
  eyebrow,
  info,
  actions,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  /** A small line above the title: the way back, or what kind of page this is. */
  eyebrow?: ReactNode;
  info?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-end justify-between gap-x-6 gap-y-3", className)}>
      <div className="min-w-0 space-y-1.5">
        {eyebrow && <div className="text-sm text-muted-foreground">{eyebrow}</div>}
        <div className="flex items-center gap-2">
          <h1 className="font-display text-[1.75rem] font-semibold leading-tight tracking-[-0.02em] text-balance sm:text-3xl">
            {title}
          </h1>
          {info}
        </div>
        {description && <p className="max-w-prose text-sm text-muted-foreground text-pretty">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
