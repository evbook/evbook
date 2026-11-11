import { useState } from "react";
import { AlertTriangle, ChevronDown, CircleCheck, CircleHelp, CircleOff } from "lucide-react";
import type { GlobalSettingsDto, TyrePressureDto, TyreRange, TyreStateDto } from "@shared/api-types";
import { TYRE_LABELS, TYRE_STATUS_LABELS, TYRE_THRESHOLDS, needsAttention, type TyreStatus } from "@shared/tyres";
import * as u from "@/lib/units";
import { dateTime } from "@/lib/format";
import { CHART_COLORS, SeriesChart } from "@/components/SeriesChart";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Segmented } from "@/components/ui/segmented";
import { Skeleton } from "@/components/ui/skeleton";
import { InfoTip } from "@/components/InfoTip";
import { cn } from "@/lib/utils";

const TONE: Record<TyreStatus, string> = {
  ok: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  low: "bg-warning/15 text-amber-700 dark:text-amber-300",
  high: "bg-warning/15 text-amber-700 dark:text-amber-300",
  "very-low": "bg-destructive/12 text-destructive",
  fault: "bg-destructive/12 text-destructive",
  unknown: "bg-foreground/[0.045] text-muted-foreground dark:bg-foreground/[0.07]",
};

function StatusIcon({ status }: { status: TyreStatus }) {
  if (status === "ok") return <CircleCheck aria-hidden="true" />;
  if (status === "unknown") return <CircleHelp aria-hidden="true" />;
  if (status === "fault") return <CircleOff aria-hidden="true" />;
  return <AlertTriangle aria-hidden="true" />;
}

const pct = (fraction: number) => `${Math.round(Math.abs(1 - fraction) * 100)} %`;

/** How the statuses are decided, in the reader's words. Mirrors `shared/tyres.ts`. */
export function TyreThresholdsTip() {
  return (
    <InfoTip label="How tyre status is decided">
      <p>
        The car's own warnings come first: a soft TPMS warning is <em>low</em>, a hard one <em>very low</em>. On top of
        that, each tyre is compared with the pressure the car recommends for its axle: more than{" "}
        {pct(TYRE_THRESHOLDS.lowBelow)} under is low, more than {pct(TYRE_THRESHOLDS.veryLowBelow)} under is very low,
        and more than {pct(TYRE_THRESHOLDS.highAbove)} over is high (a warm tyre reads about 10 % up).
      </p>
      <p>
        A tyre the car stopped reporting while the others answered is a sensor fault. A tyre with no reading is shown as
        not reported — never as fine.
      </p>
    </InfoTip>
  );
}

function Wheel({ tyre, units }: { tyre: TyreStateDto; units: GlobalSettingsDto }) {
  return (
    <div
      data-testid={`tyre-${tyre.corner}`}
      data-status={tyre.status}
      className={cn(
        "flex min-w-0 flex-col gap-1 rounded-xl border bg-card p-3",
        needsAttention(tyre.status) && "border-amber-500/40",
        (tyre.status === "very-low" || tyre.status === "fault") && "border-destructive/40",
      )}
    >
      <span className="text-xs text-muted-foreground">{TYRE_LABELS[tyre.corner]}</span>
      <span className="text-lg font-semibold tabular-nums leading-tight">
        {tyre.pressureBar == null ? "–" : u.tyrePressure(tyre.pressureBar, units)}
      </span>
      <span className="text-xs text-muted-foreground tabular-nums">
        {tyre.recommendedBar == null
          ? "No recommendation reported"
          : `Recommended ${u.tyrePressure(tyre.recommendedBar, units)}`}
      </span>
      <span
        className={cn(
          "mt-1 inline-flex w-fit items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium [&_svg]:size-3.5",
          TONE[tyre.status],
        )}
      >
        <StatusIcon status={tyre.status} />
        {TYRE_STATUS_LABELS[tyre.status]}
      </span>
    </div>
  );
}

/**
 * The four tyres where they sit on the car: front pair on top, rear pair
 * below, the body between them. Each shows its pressure against its axle's
 * recommendation and the status `shared/tyres.ts` gives it.
 */
export function TyreTile({
  data,
  loading,
  units,
}: {
  data: TyrePressureDto | undefined;
  loading: boolean;
  units: GlobalSettingsDto;
}) {
  const tyres = data?.current.tyres;
  const byCorner = (corner: TyreStateDto["corner"]) => tyres?.find((t) => t.corner === corner);
  const cell = (corner: TyreStateDto["corner"]) => {
    const tyre = byCorner(corner);
    return loading || !tyre ? <Skeleton className="h-[108px] rounded-xl" /> : <Wheel tyre={tyre} units={units} />;
  };

  return (
    <Card data-testid="tyre-tile">
      <CardHeader>
        <div className="flex items-center gap-1.5">
          <CardTitle className="text-base">Tyres</CardTitle>
          <TyreThresholdsTip />
        </div>
        <CardDescription>
          {data?.current.at != null
            ? `As the car last reported them, ${dateTime(data.current.at, units.timezone)}. Read only while the car is awake anyway — never woken for it.`
            : loading
              ? " "
              : "No tyre reading yet. Pressures are read whenever the car is awake — it is never woken for them."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="mx-auto grid max-w-xl grid-cols-[minmax(0,1fr)_3.5rem_minmax(0,1fr)] gap-3 sm:grid-cols-[minmax(0,1fr)_5rem_minmax(0,1fr)]">
          {cell("fl")}
          <div
            aria-hidden="true"
            className="row-span-2 flex flex-col items-center justify-between rounded-[2rem] border-2 border-dashed border-border py-3 text-[10px] font-medium uppercase tracking-wider text-muted-foreground"
          >
            <span>Front</span>
            <span>Rear</span>
          </div>
          {cell("fr")}
          {cell("rl")}
          {cell("rr")}
        </div>
      </CardContent>
    </Card>
  );
}

const RANGES: readonly { value: TyreRange; label: string }[] = [
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "12m", label: "12 months" },
];

/**
 * Pressures over time, one chart per axle: left and right as lines, the car's
 * recommendation for that axle dashed. The data comes in even buckets with
 * nulls where nothing was read, and the lines break there rather than drawing a
 * reading nobody took.
 */
export function TyreHistory({
  data,
  loading,
  range,
  onRange,
  units,
  defaultOpen,
}: {
  data: TyrePressureDto | undefined;
  loading: boolean;
  range: TyreRange;
  onRange: (range: TyreRange) => void;
  units: GlobalSettingsDto;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const unit = units.unitOfPressure;
  const axles = [
    { title: "Front axle", left: "fl", right: "fr", recommended: "recommendedFront" },
    { title: "Rear axle", left: "rl", right: "rr", recommended: "recommendedRear" },
  ] as const;
  const domain: [number, number] | undefined = data ? [data.from, data.to - data.bucketMs] : undefined;
  const format = (value: number) =>
    range === "12m"
      ? new Date(value).toLocaleDateString(undefined, { month: "short", year: "2-digit", timeZone: units.timezone })
      : (dateTime(value, units.timezone).split(",")[0] ?? "");

  return (
    <Card data-testid="tyre-history">
      <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((was) => !was)}
          className="-m-1 flex items-center gap-1.5 rounded-md p-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <ChevronDown
            className={cn("size-4 text-muted-foreground transition-transform", !open && "-rotate-90")}
            aria-hidden="true"
          />
          <CardTitle className="text-base">Pressures over time</CardTitle>
        </button>
        {open && <Segmented label="Pressure history range" value={range} options={RANGES} onChange={onRange} />}
      </CardHeader>
      {open && (
        <CardContent className="space-y-6">
          {axles.map((axle) => {
            const points = (data?.points ?? []).map((p) => ({
              at: p.at,
              left: u.pressureValue(p[axle.left], units),
              right: u.pressureValue(p[axle.right], units),
              recommended: u.pressureValue(p[axle.recommended], units),
            }));
            const empty = points.every((p) => p.left == null && p.right == null);
            return (
              <section key={axle.title} aria-label={axle.title} className="space-y-2">
                <h3 className="text-sm font-medium">{axle.title}</h3>
                {loading ? (
                  <Skeleton className="h-[200px]" />
                ) : empty ? (
                  <p className="py-8 text-center text-sm text-muted-foreground">
                    No pressures read in this range — the car was not awake to report them.
                  </p>
                ) : (
                  <SeriesChart
                    data={points}
                    xKey="at"
                    xDomain={domain}
                    xFormatter={format}
                    breakGaps
                    height={200}
                    series={[
                      { key: "left", label: "Left", color: CHART_COLORS.blue, unit },
                      { key: "right", label: "Right", color: CHART_COLORS.violet, unit },
                      {
                        key: "recommended",
                        label: "Recommended",
                        color: "var(--muted-foreground)",
                        unit,
                        dashed: true,
                      },
                    ]}
                  />
                )}
              </section>
            );
          })}
          <p className="text-xs text-muted-foreground">
            Each point is the average of what was read in that{" "}
            {range === "7d" ? "six hours" : range === "30d" ? "day" : "week"}. A break in a line is a stretch with no
            reading — the car was asleep or offline.
          </p>
        </CardContent>
      )}
    </Card>
  );
}
