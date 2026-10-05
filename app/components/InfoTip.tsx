import type { ReactNode } from "react";
import { Info } from "lucide-react";
import { cn } from "@/lib/utils";
import { Popover } from "@/components/ui/popover";

/**
 * The explanation behind a figure, one tap away rather than on the page.
 *
 * Every card here used to open with the paragraph that says how its numbers are
 * measured. That paragraph is worth having and not worth reading twice, so it
 * lives behind an ⓘ beside the title: the page leads with the numbers, and the
 * method is there for whoever wants it. A click rather than a hover, so it works
 * the same on a phone and stays open while it is being read.
 */
export function InfoTip({
  children,
  label = "How this is measured",
  align = "start",
  className,
}: {
  children: ReactNode;
  label?: string;
  align?: "start" | "end" | "center";
  className?: string;
}) {
  return (
    <Popover
      label={label}
      align={align}
      className={cn("inline-flex", className)}
      triggerClassName={cn(
        "grid size-6 place-items-center rounded-full text-muted-foreground/80 transition-colors",
        "hover:bg-foreground/5 hover:text-foreground aria-expanded:bg-foreground/5 aria-expanded:text-foreground",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
      )}
      trigger={<Info className="size-4" aria-hidden="true" />}
      panelClassName="w-[min(22rem,calc(100vw-2rem))] p-4 text-sm leading-relaxed text-muted-foreground text-pretty [&_p+p]:mt-2"
    >
      {children}
    </Popover>
  );
}
