import * as React from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { fieldClass } from "@/components/ui/input";

/** Native select styled to match the rest of the kit — no popover needed. */
function Select({ className, children, ...props }: React.ComponentProps<"select">) {
  return (
    // Sizing goes on the wrapper, not the select: the chevron is positioned
    // against the wrapper, so a narrower select alone would leave the arrow
    // stranded at the far edge of whatever the wrapper happens to span.
    <div className={cn("relative", className)}>
      <select className={cn("flex h-9 w-full appearance-none px-3 py-1 pr-8", fieldClass)} {...props}>
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
    </div>
  );
}

export { Select };
