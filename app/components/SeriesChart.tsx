import { useId } from "react";
import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type MouseHandlerDataParam,
} from "recharts";
import { paddedBounds, roundedDomain, sharedIntervals, ticksFor } from "@/lib/axis";
import { trendLine } from "@/lib/smooth";

export interface Series {
  key: string;
  label: string;
  color: string;
  unit?: string;
  /**
   * Which side's scale the series is measured against. Two quantities that share a
   * scale but not a unit — kilowatts against a percentage — flatten each other,
   * with the smaller one pinned to the floor. Put them on opposite sides and each
   * gets the full height: that is the shape to reach for whenever the question is
   * how two different quantities moved together over the same x-axis.
   *
   * Series quoted in the *same* unit stay on one axis. Inside against outside
   * temperature is a comparison of two numbers on one scale, and splitting them
   * would invent a crossing that never happened.
   *
   * §3.8 of docs/architecture.md has the whole convention.
   */
  axis?: "left" | "right";
  /**
   * Fill under the line with the series' own color, fading to nothing. The series
   * is still a measurement — it keeps its axis, its 2px line and its tooltip
   * entry; the fade only adds ink where the quantity *is* an amount
   * of something, the way a state of charge is an amount of battery. The fill is
   * held too faint to read a value from, so the line stays the thing being read.
   *
   * Ignored for a fitted series: the fit already draws two marks per series, and
   * ink under a line that is an estimate would lend it the weight of a logged one.
   */
  gradient?: boolean;
  /**
   * Draw the series against its own hidden scale, spanning the panel's height.
   * For a chart the reader composes: once more than two units share the panel
   * there is no side left to hang an axis on, so *every* series gives up being
   * readable as a number and each is stretched to its own full-height band —
   * the shapes stay comparable in time, and the figures live in the tooltip.
   *
   * It is still one of the measurements — a 2px line, a tooltip entry — it has
   * only lost its scale. Either all measured series own
   * their scale or none do: one full-height series next to axis-bound ones
   * would read as the biggest quantity on the chart, whatever its unit.
   */
  ownScale?: boolean;
  /**
   * Own-scale series that must still be read against *each other* share a group,
   * and with it one hidden scale — the coldest and warmest battery module, where
   * the gap between the lines is the measurement. Left ungrouped they would each
   * be stretched to their own full height, drawing a gap that is pure scaling.
   * The same-unit-one-axis rule, carried into the axis-less mode.
   */
  scaleGroup?: string;
  /**
   * Draw this one series as bars inside a line chart. For a total per period set
   * beside a rate over the same periods — cost per month against consumption —
   * where the total is an amount that sits on zero and the rate is a line that
   * moves. Its side keeps the zero baseline, like a whole chart of bars does.
   */
  mark?: "bar";
}

/**
 * Time or scalar series chart. Kept deliberately plain — one shared config for
 * every chart in the app so they read as one system.
 */
export function SeriesChart({
  data,
  series,
  xKey,
  xFormatter,
  xDomain,
  kind = "line",
  smooth = false,
  coloredAxes = false,
  height = 220,
  onHover,
}: {
  data: Record<string, number | null>[];
  series: Series[];
  xKey: string;
  xFormatter?: (value: number) => string;
  /**
   * Bounds for a proportional x-axis. Without it the axis is categorical, which
   * spaces points evenly — fine for uniformly sampled data, wrong when samples
   * are missing, because a gap in time would take up no width.
   */
  xDomain?: [number, number];
  /**
   * Bars for a distribution, a line for a series. Both live here rather than in a
   * second component so there stays one axis, grid and tooltip config for every
   * chart in the app.
   */
  kind?: "line" | "bar";
  /**
   * For a series that is *estimated* rather than logged — capacity fitted from
   * charging sessions, not a speed the car reported — draw a fit as the line and
   * leave the samples behind it, faint. Joining noisy estimates directly gives every
   * one of them the authority of the trend it belongs to, and the reader ends up
   * following a zigzag that is measurement error. `app/lib/smooth.ts` does the fit.
   *
   * Not for logged values: there the zigzag is the car, and flattening it would be
   * inventing a smoother drive than the one that happened.
   */
  smooth?: boolean;
  /**
   * Paint each axis in the color of the series it measures, when exactly one
   * series sits on it. For a chart whose series come and go at the reader's
   * choice: with both sides in muted ink there is nothing to say which scale
   * is whose. An axis shared by two series stays muted — it belongs to a unit
   * then, not a series. The fixed charts keep muted axes; their pairings are
   * named in the card title.
   */
  coloredAxes?: boolean;
  height?: number;
  /**
   * Reports the sample row under the pointer, and null when the pointer leaves or
   * sits between the plot and the card edge. For a reading that lives *outside*
   * the chart — the map cursor that shadows the tooltip. The row handed out is the
   * caller's own object from `data`, so whatever the caller keyed it by is there
   * to match on.
   */
  onHover?: (row: Record<string, number | null> | null) => void;
}) {
  // Gradient defs are document-global in SVG, so two charts on one page with the
  // same series key would silently share one. useId's delimiters are stripped
  // because the id ends up inside url(#…), which not every parser forgives.
  // Hooks may not follow the empty-data return, so this one sits above it.
  const chartId = useId().replace(/[^a-zA-Z0-9]/g, "");
  const gradientId = (key: string) => `grad-${chartId}-${key}`;

  if (data.length === 0) {
    return <p className="py-8 text-center text-sm text-muted-foreground">No samples recorded.</p>;
  }

  const hasArea = series.some((s) => s.gradient);
  const hasBarMarks = kind === "line" && series.some((s) => s.mark === "bar");
  // Recharts will not take an Area or a Bar inside a LineChart. Charts without
  // one keep the exact component they have always rendered.
  const Chart = kind === "bar" ? BarChart : hasArea || hasBarMarks ? ComposedChart : LineChart;
  const sideOf = (s: Series) => s.axis ?? "left";
  // Only axis-bound series take part in sides, bounds and the shared tick count;
  // an own-scale series is measured but hangs on a hidden axis of its own.
  const scaled = series.filter((s) => !s.ownScale);
  const floating = series.filter((s) => s.ownScale);
  const axisIdOf = (s: Series) => (s.ownScale ? `own-${s.scaleGroup ?? s.key}` : sideOf(s));
  const hasLeft = scaled.some((s) => sideOf(s) === "left");
  const hasRight = scaled.some((s) => sideOf(s) === "right");

  const fitKey = (key: string) => `${key}__fit`;
  /*
    The fit is made in whichever space the chart draws in. With a domain the x-axis is
    proportional, so the samples' own x values are what the reader sees and what the
    fit should weight by; without one the axis is categorical and spaces samples
    evenly, and a fit weighted by real distance would sit flat across a cluster of
    sessions and then step at the gap the axis is not drawing.
  */
  const xs = !(smooth && kind === "line")
    ? []
    : xDomain
      ? data.map((row) => (typeof row[xKey] === "number" ? row[xKey] : NaN))
      : data.map((_, index) => index);
  const fits =
    xs.length > 0
      ? series.map((s) =>
          trendLine(
            xs,
            data.map((row) => row[s.key] ?? null),
          ),
        )
      : [];
  /**
   * A series with too few samples to fit keeps the ordinary line. Faint points and no
   * line at all would be the chart saying it has nothing, when what it has is a
   * handful of measurements — few enough to read one by one, which is the shape a
   * plain line is already right for.
   */
  const fitted = new Set(series.filter((_, i) => fits[i]?.some((value) => value != null)).map((s) => s.key));
  const isFit = (s: Series) => fitted.has(s.key);
  const rows =
    fitted.size === 0
      ? data
      : data.map((row, index) => {
          const next = { ...row };
          series.forEach((s, i) => {
            if (isFit(s)) next[fitKey(s.key)] = fits[i]![index] ?? null;
          });
          return next;
        });

  /**
   * Bars keep the zero baseline they are read against — shortening a bar's floor
   * exaggerates the difference between two of them. Only lines get the padding.
   */
  const boundsFor = (side: "left" | "right"): [number, number] | undefined => {
    if (kind === "bar") return undefined;
    const own = scaled.filter((s) => sideOf(s) === side);
    const barred = own.some((s) => s.mark === "bar");
    // The fit as well as the samples: a slope read off the last of them can sit a
    // little outside their range, and an axis that ignored it would clip the line.
    const keys = own.flatMap((s) => (isFit(s) ? [s.key, fitKey(s.key)] : [s.key]));
    const values = rows
      .flatMap((row) => keys.map((key) => row[key]))
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    // A percentage stops at 100 and nothing measured in a physical unit here goes
    // below zero, so those are the ends the padding may not push past.
    const limit: [number, number] = own.every((s) => s.unit === "%")
      ? [0, 100]
      : [values.some((value) => value < 0) ? -Infinity : 0, Infinity];
    const padded = paddedBounds(values, limit);
    // A side holding bars is read from zero: shortening a bar's floor exaggerates
    // the difference between two of them. Still rounded and tick-shared with the
    // other side, so the gridlines keep belonging to both.
    return barred && padded ? [Math.min(0, padded[0]), padded[1]] : padded;
  };

  const bounds = { left: boundsFor("left"), right: hasRight ? boundsFor("right") : undefined };
  const axisBounds = [bounds.left, bounds.right].filter((b): b is [number, number] => b != null);
  const intervals = axisBounds.length > 0 ? sharedIntervals(axisBounds) : 4;

  /**
   * The full-height band an own-scale series — or a scale group of them — is
   * stretched over. `paddedBounds`, as for an axis: these are measurements, and
   * each deserves the whole panel — it is only the axis they have given up.
   */
  const floatingDomain = (own: Series[]): [number, number] | undefined => {
    const values = rows
      .flatMap((row) => own.map((s) => row[s.key]))
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    const limit: [number, number] = own.every((s) => s.unit === "%")
      ? [0, 100]
      : [values.some((value) => value < 0) ? -Infinity : 0, Infinity];
    return paddedBounds(values, limit);
  };

  /**
   * Recharts hands the active index as a number or, in newer chart types, a path
   * string; both coerce. It also keeps firing while the pointer crosses the axis
   * gutter with no sample active, so the guard turns those into the same "nothing"
   * a leave is — the marker on the other end should never outlive the tooltip.
   */
  const reportHover = (state: MouseHandlerDataParam) => {
    const index = state.isTooltipActive ? Number(state.activeTooltipIndex) : NaN;
    onHover?.(Number.isInteger(index) ? (data[index] ?? null) : null);
  };

  const yAxisProps = (side: "left" | "right") => {
    const own = bounds[side];
    const domain = own ? roundedDomain(own, intervals) : undefined;
    // The axis wears its series' color only while everything it measures wears
    // that color too — one series, or a pair drawn as one (the pack modules). A
    // side shared by differently-colored series belongs to their unit, not to
    // any of them, and stays muted.
    const owners = scaled.filter((s) => sideOf(s) === side);
    const shared = new Set(owners.map((s) => s.color));
    const color = coloredAxes && shared.size === 1 ? owners[0]!.color : undefined;
    return {
      yAxisId: side,
      orientation: side,
      tick: { fontSize: 11, fill: color ?? "var(--muted-foreground)" },
      stroke: color ?? "var(--border)",
      // The axis line only where it carries a series' colour — the link between
      // a scale and its line. A muted one is just another rule beside the grid.
      axisLine: color != null,
      tickLine: false,
      width: 52,
      ...(domain ? { domain, ticks: ticksFor(domain, intervals) } : {}),
    } as const;
  };

  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        {/* The left margin is negative to claw back the gap recharts leaves beside
            the axis, but not past the point where a four-digit tick — a sample count,
            a projected mileage — loses its leading digit and silently reads as a
            number eight times smaller. A second axis needs that gap on its own side,
            so the right margin gives it back when there is one. */}
        <Chart
          data={rows}
          margin={{ top: 8, right: hasRight ? -8 : 8, bottom: 0, left: hasLeft ? -8 : 8 }}
          {...(onHover
            ? {
                onMouseMove: reportHover,
                onMouseLeave: () => onHover(null),
                // Touch gets the same shadow the mouse does: dragging a finger
                // across the chart walks the tooltip, so it walks the marker too.
                onTouchMove: reportHover,
                onTouchEnd: () => onHover(null),
              }
            : {})}
        >
          {series.some((s) => s.gradient) && (
            <defs>
              {series
                .filter((s) => s.gradient)
                .map((s) => (
                  <linearGradient key={s.key} id={gradientId(s.key)} x1="0" y1="0" x2="0" y2="1">
                    {/* Faint at the line and gone by the baseline: strong enough
                        to read the ink as an amount, never enough to hide the
                        gridlines or another series' fill underneath. */}
                    <stop offset="5%" stopColor={s.color} stopOpacity={0.3} />
                    <stop offset="95%" stopColor={s.color} stopOpacity={0} />
                  </linearGradient>
                ))}
            </defs>
          )}
          {/* Pinned to the left axis: the gridlines have to belong to one scale, and
              both axes carry the same number of ticks so the right one lands on them too.
              With no axes at all there is no scale for a gridline to belong to, so a
              chart of own-scale series draws none — a rule at some height would invite
              reading it against every line at once, and it would be true for none. */}
          {hasLeft && <CartesianGrid yAxisId="left" stroke="var(--border)" strokeOpacity={0.8} vertical={false} />}
          <XAxis
            dataKey={xKey}
            tickFormatter={xFormatter}
            tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
            stroke="var(--border)"
            tickLine={false}
            tickMargin={8}
            minTickGap={32}
            {...(xDomain ? ({ type: "number", domain: xDomain, scale: "linear" } as const) : {})}
          />
          {hasLeft && <YAxis {...yAxisProps("left")} />}
          {hasRight && <YAxis {...yAxisProps("right")} />}
          {/* One hidden axis per own-scale series — or per scale group of them —
              so each fills the height on its own terms. `width={0}` as well as
              `hide`, and both are load-bearing: hidden alone still claims a left
              gutter the width of a default axis, which pushes the real left axis
              clean off the canvas and silently loses its labels. */}
          {[...new Set(floating.map(axisIdOf))].map((axisId) => {
            const own = floating.filter((s) => axisIdOf(s) === axisId);
            const domain = floatingDomain(own);
            return <YAxis key={axisId} yAxisId={axisId} hide width={0} {...(domain ? { domain } : {})} />;
          })}
          <Tooltip
            cursor={
              kind === "bar" || hasBarMarks
                ? { fill: "var(--foreground)", fillOpacity: 0.04 }
                : { stroke: "var(--muted-foreground)", strokeOpacity: 0.4, strokeDasharray: "3 3" }
            }
            contentStyle={{
              background: "color-mix(in oklch, var(--popover) 92%, transparent)",
              backdropFilter: "blur(8px)",
              border: "1px solid var(--border)",
              borderRadius: 12,
              boxShadow: "var(--shadow-overlay)",
              padding: "10px 12px",
              fontSize: 12,
              color: "var(--popover-foreground)",
            }}
            labelStyle={{ color: "var(--muted-foreground)", marginBottom: 4, fontWeight: 500 }}
            itemStyle={{ padding: "1px 0", fontVariantNumeric: "tabular-nums" }}
            labelFormatter={(value) => (xFormatter ? xFormatter(Number(value)) : String(value))}
            formatter={(value, name) => {
              const match = series.find((s) => s.label === name);
              return [`${value}${match?.unit ? ` ${match.unit}` : ""}`, name];
            }}
          />
          {series.flatMap((s) =>
            // No draw-in on any of them. These are dense analytical charts, so the
            // animation adds nothing, and a half-drawn line is what a screenshot of
            // one catches — the story screens are documentation.
            kind === "bar"
              ? [
                  <Bar
                    key={s.key}
                    yAxisId={axisIdOf(s)}
                    dataKey={s.key}
                    name={s.label}
                    fill={s.color}
                    radius={[4, 4, 0, 0]}
                    maxBarSize={36}
                    isAnimationActive={false}
                  />,
                ]
              : s.mark === "bar"
                ? [
                    <Bar
                      key={s.key}
                      yAxisId={axisIdOf(s)}
                      dataKey={s.key}
                      name={s.label}
                      fill={s.color}
                      fillOpacity={0.85}
                      radius={[4, 4, 0, 0]}
                      maxBarSize={36}
                      isAnimationActive={false}
                    />,
                  ]
                : [
                    s.gradient && !isFit(s) ? (
                      // An Area draws the same 2px line a Line would, plus the fade
                      // beneath it, so the series swaps components rather than
                      // gaining one — one mark, one tooltip entry, either way.
                      <Area
                        key={s.key}
                        yAxisId={axisIdOf(s)}
                        type="monotone"
                        dataKey={s.key}
                        name={s.label}
                        stroke={s.color}
                        strokeWidth={2}
                        fill={`url(#${gradientId(s.key)})`}
                        dot={false}
                        activeDot={ACTIVE_DOT}
                        connectNulls
                        isAnimationActive={false}
                      />
                    ) : (
                      <Line
                        key={s.key}
                        yAxisId={axisIdOf(s)}
                        // Straight between samples when they are only being shown rather
                        // than followed: a curve through them would add wiggles of its own
                        // to the ones the fit is there to take out.
                        type={isFit(s) ? "linear" : "monotone"}
                        dataKey={s.key}
                        name={s.label}
                        stroke={s.color}
                        {...(isFit(s)
                          ? {
                              // Faint enough to read as a cloud the line passes through,
                              // solid enough to still count the sessions and see where the
                              // fit had little to go on.
                              strokeWidth: 1,
                              strokeOpacity: 0.2,
                              dot: { r: 1.5, fill: s.color, fillOpacity: 0.45, strokeWidth: 0 },
                            }
                          : { strokeWidth: 2, dot: false, activeDot: ACTIVE_DOT })}
                        connectNulls
                        isAnimationActive={false}
                      />
                    ),
                    // The fit stays out of the tooltip: hovering a session should give
                    // that session's measurement, and the same figure twice with one of
                    // them quietly different would only read as a bug.
                    ...(isFit(s)
                      ? [
                          <Line
                            key={fitKey(s.key)}
                            yAxisId={axisIdOf(s)}
                            type="monotone"
                            dataKey={fitKey(s.key)}
                            name={s.label}
                            stroke={s.color}
                            strokeWidth={2}
                            dot={false}
                            connectNulls
                            tooltipType="none"
                            isAnimationActive={false}
                          />,
                        ]
                      : []),
                  ],
          )}
        </Chart>
      </ResponsiveContainer>
    </div>
  );
}

/** The hovered sample: a dot in the series' colour, ringed in the card's. */
const ACTIVE_DOT = { r: 4, strokeWidth: 2, stroke: "var(--card)" } as const;

/**
 * Shared categorical palette, accessible in light and dark. Bronze exists for
 * elevation on the drive chart, where teal (its color in the fixed chart) is
 * already worn by range: an earthy tone for the ground, and the best-separated
 * seventh hue against the other six under the CVD checks — its one weak pair is
 * red under protanopia, which the chip labels and tooltip carry through.
 */
export const CHART_COLORS = {
  blue: "#3b82f6",
  green: "#10b981",
  amber: "#f59e0b",
  red: "#ef4444",
  violet: "#8b5cf6",
  teal: "#14b8a6",
  bronze: "#a16207",
} as const;
