import type { StateTimelineDto, TimelineState } from "@shared/api-types";
import * as u from "@/lib/units";
import { dateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { CHART_COLORS } from "@/components/SeriesChart";

/**
 * What the car was doing, as one proportional band — the replacement for
 * TeslaMate's state-timeline panel. Plain divs rather than a chart library:
 * it is a proportion of a window, not a plot of values.
 *
 * "Online" gets the warning colour on purpose. An awake, idle car is the thing
 * you are looking for when you come here, because it means polling is holding
 * the car up instead of letting it sleep.
 */
const STATE_COLORS: Record<TimelineState, string> = {
  driving: CHART_COLORS.blue,
  charging: CHART_COLORS.green,
  updating: CHART_COLORS.violet,
  online: CHART_COLORS.amber,
  // Calm slates for the states you want to see most of, chosen to stay legible
  // on both a light and a dark card. Unknown is left blank on purpose: a gap in
  // the log should look like a gap.
  asleep: "#94a3b8",
  offline: "#475569",
  unknown: "transparent",
};

/**
 * The colour a state is drawn in, as a chip to put beside its name — in this
 * band's own legend, and anywhere else the same states are named. The colours
 * only mean anything if one thing is one colour everywhere.
 */
export function StateSwatch({ state, className }: { state: TimelineState; className?: string }) {
  return (
    <span aria-hidden className={cn("size-3 shrink-0 rounded-sm border", className)} style={{ background: STATE_COLORS[state] }} />
  );
}

/** Evenly spaced ticks across the window, at most `count` of them. */
function ticksFor(from: number, to: number, count: number): number[] {
  if (to <= from) return [];
  return Array.from({ length: count + 1 }, (_, i) => from + ((to - from) * i) / count);
}

export function StateBand({ timeline, timezone }: { timeline: StateTimelineDto; timezone: string }) {
  const window = timeline.to - timeline.from;
  if (window <= 0 || timeline.spans.length === 0) {
    return <p className="py-8 text-center text-sm text-muted-foreground">Nothing logged in this window yet.</p>;
  }

  const multiDay = window > 2 * 86_400_000;
  const label = (at: number) =>
    multiDay
      ? new Date(at).toLocaleDateString(undefined, { timeZone: timezone, month: "short", day: "2-digit" })
      : new Date(at).toLocaleTimeString(undefined, { timeZone: timezone, hour: "2-digit", minute: "2-digit" });

  return (
    <div className="space-y-3">
      {/*
        Absolutely positioned rather than flexed: a long window holds hundreds of
        spans, and with flex the minimum widths add up to more than the container,
        so every span shrinks and the band stops being proportional to time.
        Positioning each span outright keeps it honest at any span count, and an
        uncovered stretch simply shows the card behind it.
      */}
      <div className="relative h-9 w-full overflow-hidden rounded-lg bg-foreground/[0.04] ring-1 ring-inset ring-border dark:bg-foreground/[0.06]">
        {timeline.spans.map((span) => (
          <div
            key={span.from}
            className="absolute inset-y-0"
            style={{
              left: `${((span.from - timeline.from) / window) * 100}%`,
              // A brief span must still be findable, hence the floor on width.
              width:
                span.state === "unknown"
                  ? `${((span.to - span.from) / window) * 100}%`
                  : `max(2px, ${((span.to - span.from) / window) * 100}%)`,
              background: STATE_COLORS[span.state],
            }}
            title={`${u.stateLabel(span.state)} · ${dateTime(span.from, timezone)} → ${dateTime(
              span.to,
              timezone,
            )} · ${u.duration((span.to - span.from) / 1000)}`}
          />
        ))}
      </div>

      <div className="flex justify-between text-[11px] text-muted-foreground">
        {ticksFor(timeline.from, timeline.to, multiDay ? 4 : 6).map((at) => (
          <span key={at} className="tabular-nums">
            {label(at)}
          </span>
        ))}
      </div>

      {/* The legend as chips: one per state, with its share — the band's answer
          in words, for whoever wants the figure rather than the picture. */}
      <ul className="flex flex-wrap gap-2 pt-1 text-sm">
        {timeline.totals.map((total) => (
          <li
            key={total.state}
            className="flex items-center gap-2 rounded-full bg-foreground/[0.04] py-1 pl-2 pr-3 dark:bg-foreground/[0.07]"
          >
            <StateSwatch state={total.state} className="size-2.5 rounded-full border-0" />
            <span className="font-medium">{u.stateLabel(total.state)}</span>
            <span className="tabular-nums text-muted-foreground">
              {u.duration(total.ms / 1000)} · {Math.round(total.share * 100)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
