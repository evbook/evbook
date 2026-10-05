import { Figure } from "@/components/Figure";
import { Card } from "@/components/ui/card";

export interface Stat {
  label: string;
  value: string;
  /**
   * The small line under the value.
   *
   * `null` means this tile has a hint whose text is not known yet — the line is
   * kept empty rather than removed, so the tile is the same height before and
   * after the answer arrives. Omit the field entirely for a tile that never has
   * a hint; that one keeps no space for it.
   */
  hint?: string | null;
}

/**
 * A total spread over the rows it was summed from, for the line under a tile.
 * Null when there is no total or nothing to divide it by, so the caller can leave
 * the line empty rather than print an average of nothing.
 *
 * Which count to hand it is the caller's decision and worth thinking about: it
 * should be the rows the sum actually has a figure for, which is every row for
 * something like distance and only some of them for something like charge cost.
 */
export function perItem(total: number | null | undefined, count: number | undefined): number | null {
  if (total == null || !count) return null;
  return total / count;
}

/** Row of summary figures shown above a list or on a detail page. */
export function StatTiles({ stats }: { stats: Stat[] }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {stats.map((stat) => (
        <Card key={stat.label} className="p-4 sm:p-5">
          <p className="text-xs font-medium text-muted-foreground">{stat.label}</p>
          {/* The number in the display cut and the unit set back beside it, as on
              the overview: "1,877 km" reads as one figure with a label. */}
          <p className="mt-2.5 text-2xl font-semibold sm:text-[1.75rem]">
            <Figure text={stat.value} />
          </p>
          {/*
            The hint's space is held whether or not there is anything to put in
            it. A hint that appeared only once the data did was making the whole
            row grow as it loaded and shrink again on the next filter change — the
            tiles are grid items, so every one of them is as tall as the tallest,
            and a single late hint moved all four.

            Two lines below `xl`, where four tiles across leave each one too
            narrow for a sentence to fit on one; one line at `xl` and up, where
            they do fit and a second reserved line would just be a gap. It is a
            floor, not a limit: a hint longer than the space is never cut.
          */}
          {stat.hint !== undefined && (
            <p className="mt-2 min-h-8 text-xs text-muted-foreground xl:min-h-4">{stat.hint}</p>
          )}
        </Card>
      ))}
    </div>
  );
}
