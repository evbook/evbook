import { cn } from "@/lib/utils";

/**
 * The pack as a glance: a battery icon filled to the level, with the figure
 * beside it. The icon alone was tried first and read as decoration — a bar
 * without a scale — so the number stays, and the fill only echoes it.
 *
 * Renders nothing when the level is unknown: an empty battery outline is a
 * statement ("the pack was flat"), not an absence.
 */
export function BatteryLevel({ level, className }: { level: number | null | undefined; className?: string }) {
  if (level == null) return null;
  const clamped = Math.max(0, Math.min(100, level));
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 align-middle text-xs font-normal tabular-nums text-muted-foreground",
        className,
      )}
    >
      {/* The body's inner well runs x 4–17.5, so the fill is that width scaled. */}
      <svg viewBox="0 0 24 24" className="size-4 shrink-0" aria-hidden="true" fill="currentColor">
        <path d="M4 18q-1.25 0-2.125-.875T1 15V9q0-1.25.875-2.125T4 6h13.5q1.25 0 2.125.875T20.5 9v6q0 1.25-.875 2.125T17.5 18zm0-2h13.5q.425 0 .713-.288T18.5 15V9q0-.425-.288-.712T17.5 8H4q-.425 0-.712.288T3 9v6q0 .425.288.713T4 16m17.5-1.5v-5h.5q.425 0 .713.288T23 10.5v3q0 .425-.288.713T22 14.5z" />
        <rect x="4" y="9" width={(13.5 * clamped) / 100} height="6" />
      </svg>
      {level} %
    </span>
  );
}
