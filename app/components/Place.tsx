/**
 * Where something happened: the spot, and the town it sits in, dimmed.
 *
 * A street name alone only means something to someone who already knows the town,
 * but the town is not what the reader is scanning for either — it is what tells
 * two Bahnhofstraßen apart once they have found them. Setting it back a shade
 * keeps a column of places scannable by the half that differs.
 *
 * The two halves arrive from the API as separate fields rather than one string,
 * so nothing here has to guess at a comma that a street or a geofence name is
 * free to contain. A geofence has no region: it is what the owner called the
 * place, and "Home" is already the whole answer.
 *
 * In a table the region goes on a second line, which is what stops a column of
 * places from setting the width of the whole table — one line of "Aristofani,
 * Ypsonas Municipality" needs about 250px and truncates whatever it is given,
 * while two lines need only the wider half. `inline` is for the places that have
 * no second line to use: a heading, or a run of "from → to" where stacking two
 * regions under one arrow would say nothing about which belonged to which.
 */
import type { ReactNode } from "react";
import { TripIcon } from "@/components/TripIcon";

export function Place({
  label,
  region,
  fallback = "–",
  inline = false,
  badge,
}: {
  label: string | null;
  region?: string | null;
  fallback?: string;
  inline?: boolean;
  /** An annotation that belongs to the spot, not the town — it sits on the first line. */
  badge?: ReactNode;
}) {
  // A spot we could not name is no reason to throw away the town we could. The
  // region is promoted rather than shown under a dash: "Pano Polemidia Community"
  // on its own is the whole of what is known, and a dash above it would read as
  // two facts, one of them missing.
  if (!label) return <>{region || fallback}</>;
  const mark = badge ? <span className="ml-2">{badge}</span> : null;
  if (!region) {
    return (
      <>
        {label}
        {mark}
      </>
    );
  }
  return (
    <>
      {label}
      {mark}
      {inline ? (
        <span className="text-muted-foreground">, {region}</span>
      ) : (
        // No comma: a line break already separates them, and the same weight and
        // size as the duration under a distance, so the two columns read as one row.
        <span className="block text-xs font-normal text-muted-foreground">{region}</span>
      )}
    </>
  );
}

/**
 * A drive read as one line: where it started, an arrow, where it ended.
 *
 * Most drives stay inside one town, and "Griva Digeni 122a, Limassol → Stratigou
 * Gianni Timagia 17, Limassol" spends half its width saying Limassol twice. The
 * town is a fact about the drive, not about each end of it, so it is said once —
 * at the end, where it also reads as the answer to "and where did that leave me".
 * A drive that crosses a boundary keeps both, which is the case the region was
 * there for.
 *
 * The start's region is only dropped when the start has a label of its own to
 * stand on: with no label `Place` promotes the region to be the whole answer, and
 * taking it away would leave a bare dash on one side of the arrow.
 */
export function PlacePair({
  startLabel,
  startRegion,
  endLabel,
  endRegion,
  startFallback,
  endFallback,
}: {
  startLabel: string | null;
  startRegion?: string | null;
  endLabel: string | null;
  endRegion?: string | null;
  startFallback?: string;
  endFallback?: string;
}) {
  const sharedRegion = Boolean(startLabel && startRegion && startRegion === endRegion);
  return (
    <>
      <Place label={startLabel} region={sharedRegion ? null : startRegion} fallback={startFallback} inline />{" "}
      <TripIcon /> <Place label={endLabel} region={endRegion} fallback={endFallback} inline />
    </>
  );
}

/** The same thing as one string, for a `title` tooltip or an accessible name. */
export function placeText(label: string | null, region?: string | null): string | undefined {
  if (!label) return undefined;
  return region ? `${label}, ${region}` : label;
}
