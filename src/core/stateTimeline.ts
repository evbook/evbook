/**
 * What the car was doing, as one continuous band of spans.
 *
 * The logger records online/asleep/offline in `states`, and records driving,
 * charging and updating separately as drives, charging processes and updates.
 * A reader wants one band, so the overlays are punched into the base states
 * here: this is the replacement for TeslaMate's state-timeline panel, which does
 * the same union in SQL.
 *
 * Kept pure and free of SQL so the precedence rules are testable directly.
 */

export type TimelineState = "driving" | "charging" | "updating" | "online" | "asleep" | "offline" | "unknown";

/** Higher wins where spans overlap. */
const PRECEDENCE: Record<TimelineState, number> = {
  updating: 5,
  driving: 4,
  charging: 3,
  online: 2,
  asleep: 2,
  offline: 2,
  unknown: 0,
};

export interface Span {
  state: TimelineState;
  from: number;
  /** Exclusive. */
  to: number;
}

export interface StateTotal {
  state: TimelineState;
  ms: number;
  /** Fraction of the window, 0..1. */
  share: number;
}

/**
 * Merge overlapping spans into a gapless band covering [from, to).
 *
 * Any part of the window no span covers becomes `unknown` rather than being
 * dropped — a gap in the log is information, not something to paper over, and it
 * is what a stopped import or an evicted Worker leaves behind.
 */
export function mergeSpans(spans: Span[], from: number, to: number): Span[] {
  if (to <= from) return [];

  const clamped = spans
    .map((s) => ({ state: s.state, from: Math.max(s.from, from), to: Math.min(s.to, to) }))
    .filter((s) => s.to > s.from);

  // Every point at which the winning state could change.
  const edges = new Set<number>([from, to]);
  for (const span of clamped) {
    edges.add(span.from);
    edges.add(span.to);
  }
  const points = [...edges].sort((a, b) => a - b);

  const band: Span[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const start = points[i]!;
    const end = points[i + 1]!;
    // Resolve on the interval, not on an instant, so a zero-length span can
    // never win and `to` being exclusive is respected.
    const covering = clamped.filter((s) => s.from <= start && s.to >= end);
    const winner = covering.reduce<TimelineState>(
      (best, s) => (PRECEDENCE[s.state] > PRECEDENCE[best] ? s.state : best),
      "unknown",
    );

    const previous = band[band.length - 1];
    if (previous?.state === winner) previous.to = end;
    else band.push({ state: winner, from: start, to: end });
  }

  return band;
}

/** How long the car spent in each state, and what share of the window that is. */
export function totalsFor(band: Span[], from: number, to: number): StateTotal[] {
  const window = Math.max(0, to - from);
  const byState = new Map<TimelineState, number>();
  for (const span of band) {
    byState.set(span.state, (byState.get(span.state) ?? 0) + (span.to - span.from));
  }
  return [...byState.entries()]
    .map(([state, ms]) => ({ state, ms, share: window > 0 ? ms / window : 0 }))
    .sort((a, b) => b.ms - a.ms);
}
