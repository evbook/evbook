import type { ReactNode } from "react";
import { splitUnit } from "@/lib/figure";
import { cn } from "@/lib/utils";

/** A reading set as a figure: the number in the display cut, its unit beside it. */
export function Figure({ text, className }: { text: string; className?: string }) {
  const { value, unit } = splitUnit(text);
  return (
    <span className={cn("evb-figure", className)}>
      {value}
      {unit && <span className="evb-unit">{unit}</span>}
    </span>
  );
}

/**
 * One reading in a strip of them: a small label with its icon, the figure under
 * it. The label is a `dt` and the figure a `dd`, so a row of these is still a
 * description list to anything reading the page by structure.
 */
export function Metric({
  label,
  value,
  icon,
  className,
}: {
  label: string;
  value: string;
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0 px-3 py-3.5 sm:px-5", className)}>
      <dt className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground [&_svg]:hidden [&_svg]:size-3.5 [&_svg]:shrink-0 sm:[&_svg]:block">
        {icon}
        <span className="truncate">{label}</span>
      </dt>
      <dd className="mt-2 whitespace-nowrap text-lg font-semibold sm:text-2xl">
        <Figure text={value} />
      </dd>
    </div>
  );
}
