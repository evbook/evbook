import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A segmented control: one well, and the chosen option is the raised segment.
 * Buttons with `aria-pressed` rather than radios, like the kit's other toggles, so
 * each segment is a plain button to a keyboard and to the stories.
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  size = "sm",
  className,
}: {
  value: T;
  options: readonly { value: T; label: ReactNode; title?: string }[];
  onChange: (value: T) => void;
  /** Names the group for a screen reader; the segments name themselves. */
  label: string;
  size?: "sm" | "md";
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn("inline-flex gap-0.5 rounded-lg border bg-muted/60 p-0.5", className)}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          title={option.title}
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            "inline-flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium",
            "transition-[color,background-color,box-shadow] duration-150 [&_svg]:size-3.5 [&_svg]:shrink-0",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
            size === "sm" ? "px-2.5 py-1 text-xs" : "px-3 py-1.5 text-sm",
            value === option.value
              ? "bg-card text-foreground shadow-card"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
