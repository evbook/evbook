import type { Make } from "@/lib/makes";
import { cn } from "@/lib/utils";

/**
 * A make's mark: its initial in a tile. Deliberately not the maker's logo —
 * those are trademarks, and a row of six of them would turn a picker into an
 * advert. The name beside it does the telling; this gives the row a handle.
 */
export function MakeMark({ make, className }: { make: Make; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid size-10 shrink-0 place-items-center rounded-xl bg-muted font-display text-base font-semibold text-foreground/80",
        className,
      )}
    >
      {make.name.charAt(0)}
    </span>
  );
}
