import { cn } from "@/lib/utils";

/**
 * A drive as a glyph: a hollow ring for where it started, a filled dot for where
 * it ended, and a quiet line between — the maps-app convention, so it reads
 * without a legend. It sits between a drive's start and end where a bare "→"
 * used to. The glyph is hidden from assistive tech, so a visually hidden "to"
 * keeps the pair readable aloud.
 *
 * It is sized to the text, not the other way round: the viewBox is 20 units per
 * em, so the markers are a third of an em across (about a lowercase bowl) and the
 * strokes about a font stem, whatever the size it sits in. `align-middle` centres
 * it on the x-height. It is coloured as metadata, in the same grey as a date, so
 * the place names either side carry the weight.
 */
export function TripIcon({ className }: { className?: string }) {
  return (
    <>
      <svg
        viewBox="0 0 32 20"
        className={cn(
          "mx-[0.2em] inline-block h-[1em] w-[1.6em] shrink-0 align-middle text-muted-foreground",
          className,
        )}
        aria-hidden="true"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      >
        <circle cx="4" cy="10" r="2.65" />
        <line x1="9" y1="10" x2="23" y2="10" opacity="0.4" />
        <circle cx="28" cy="10" r="3.3" fill="currentColor" stroke="none" />
      </svg>
      <span className="sr-only">to</span>
    </>
  );
}
