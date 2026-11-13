import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import { ArrowLeft, Download } from "lucide-react";
import type { ChargeDetailDto, ChargeSampleDto } from "@shared/api-types";
import type { CurrencyCode } from "@shared/currency";
import { api } from "@/lib/api";
import { explainCost } from "@/lib/tariff";
import * as u from "@/lib/units";
import { cost, eventDateline, eventDuration, number, rate } from "@/lib/format";
import { ReconstructedBadge } from "@/components/Reconstructed";
import { useAppSettings } from "@/hooks/useAppSettings";
import {
  CHARGE_CHART_SERIES,
  DEFAULT_CHARGE_CHART,
  readChargeChart,
  saveChargeChart,
  type ChargeChartPrefs,
  type ChargeChartSeriesKey,
} from "@/lib/chargeChartStore";
import { cn } from "@/lib/utils";
import { CarMap } from "@/components/CarMap";
import { CHART_COLORS, SeriesChart, type Series } from "@/components/SeriesChart";
import { StatTiles } from "@/components/StatTiles";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDate } from "@/lib/datetime";

/**
 * Where the session's cost came from, in one line: what the tariff billed and
 * at which rates, or that the figure is the owner's, or kept from before tariffs.
 */
function costExplanation(charge: ChargeDetailDto, currency: CurrencyCode): string | null {
  if (charge.costCents == null) return null;
  switch (charge.costSource) {
    case "manual": {
      const billed = charge.costBilledKwh != null ? `, ${number(charge.costBilledKwh, 1)} kWh billed` : "";
      return `Entered by hand${billed}${charge.costNote ? ` — ${charge.costNote}` : ""}.`;
    }
    case "legacy":
      return "Recorded before time-of-use tariffs and kept as it was: the place's tariff does not reproduce it.";
    case "tariff":
      return charge.costDetail ? explainCost(charge.costDetail, currency) : null;
    default:
      return null;
  }
}

/**
 * Cost editor — the equivalent of TeslaMate's /charge-cost/:id page. The total,
 * fees and all, plus the kWh the bill names and a note. A figure saved here is
 * the owner's: no tariff change touches it again. Clearing it hands the session
 * back to the place's tariff.
 */
function CostEditor({ charge, currency }: { charge: ChargeDetailDto; currency: CurrencyCode }) {
  const queryClient = useQueryClient();
  const manual = charge.costSource === "manual";
  const [value, setValue] = useState(manual && charge.costCents != null ? (charge.costCents / 100).toFixed(2) : "");
  const [billedKwh, setBilledKwh] = useState(
    manual && charge.costBilledKwh != null ? String(charge.costBilledKwh) : "",
  );
  const [note, setNote] = useState(manual ? (charge.costNote ?? "") : "");
  const [saved, setSaved] = useState(false);

  const save = useMutation({
    mutationFn: (body: { value: number | null; billedKwh?: number | null; note?: string | null }) =>
      api(`/api/v1/charges/${charge.id}/cost`, { method: "PUT", body: JSON.stringify(body) }),
    onSuccess: async () => {
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2000);
      await queryClient.invalidateQueries({ queryKey: ["charge", String(charge.id)] });
      await queryClient.invalidateQueries({ queryKey: ["charges"] });
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    const parse = (text: string) => (text.trim() === "" ? null : Number(text.trim().replace(",", ".")));
    const parsed = parse(value);
    const kwh = parse(billedKwh);
    if (parsed !== null && !Number.isFinite(parsed)) return;
    if (kwh !== null && !Number.isFinite(kwh)) return;
    if (parsed === null) {
      setBilledKwh("");
      setNote("");
      save.mutate({ value: null });
    } else {
      save.mutate({ value: parsed, billedKwh: kwh, note: note.trim() || null });
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Cost</CardTitle>
        <CardDescription>
          {manual
            ? "Your own figure, which no tariff change touches. Clear the total to let the place's tariff price it again."
            : "Have the bill? Enter what this session cost, fees and all, and it replaces the tariff's estimate."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            {/* The account's currency, so a number typed here is unambiguous —
                the field takes a bare figure and the setting says what it buys. */}
            <Label htmlFor="cost-value">Total ({currency})</Label>
            <Input
              id="cost-value"
              className="w-28"
              inputMode="decimal"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={charge.costCents != null && !manual ? (charge.costCents / 100).toFixed(2) : "0.00"}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cost-kwh">Billed kWh</Label>
            <Input
              id="cost-kwh"
              className="w-24"
              inputMode="decimal"
              value={billedKwh}
              onChange={(e) => setBilledKwh(e.target.value)}
              placeholder="optional"
            />
          </div>
          <div className="min-w-40 flex-1 space-y-1.5">
            <Label htmlFor="cost-note">Note</Label>
            <Input
              id="cost-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="optional"
              maxLength={500}
            />
          </div>
          <Button type="submit" disabled={save.isPending}>
            {saved ? "Saved" : save.isPending ? "Saving…" : "Save"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

/**
 * Volts and amps at the session's strongest moment — recorded on every sample since
 * the beginning and never shown until now. It is what tells an 11 kW session on
 * three phases from one on a single phase at 48 A, which is the difference between a
 * house that needs an electrician and one that does not.
 */
function supplyAtPeak(charge: ChargeDetailDto): string {
  const peak = charge.samples.reduce<ChargeSampleDto | null>(
    (best, sample) => (best == null || sample.powerKw > best.powerKw ? sample : best),
    null,
  );
  const parts = [
    peak?.voltage != null ? `${Math.round(peak.voltage)} V` : null,
    peak?.current != null ? `${Math.round(peak.current)} A` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : "–";
}

/** The second row of tiles, in the skeleton and the loaded page alike. */
const EXTREME_TILE_LABELS = ["Max power", "Supply at peak", "Charging efficiency", "Ø outside temperature"] as const;

export function ChargeDetailPage() {
  const { id } = useParams();
  const settings = useAppSettings();
  const charge = useQuery({
    queryKey: ["charge", id],
    queryFn: () => api<ChargeDetailDto>(`/api/v1/charges/${id}`),
    enabled: Boolean(id),
  });
  // How the telemetry chart was last set up — on any session; it is a way of
  // reading, not a fact about this one — restored once at mount.
  const [chart, setChart] = useState(() => readChargeChart() ?? DEFAULT_CHARGE_CHART);
  const updateChart = (next: ChargeChartPrefs) => {
    saveChargeChart(next);
    setChart(next);
  };
  // One pass through the canonical list both flips the key and keeps the stored
  // set in canonical order, so which chip holds which axis never depends on the
  // order things were clicked in.
  const toggleSeries = (key: ChargeChartSeriesKey) =>
    updateChart({
      ...chart,
      series: CHARGE_CHART_SERIES.filter((k) => (k === key ? !chart.series.includes(k) : chart.series.includes(k))),
    });

  if (!settings.data || charge.isLoading) {
    /*
      The loaded page's own frame: back link, tile labels, and the chart card,
      each at its final size. Only the words and lines are still to come, so
      nothing moves when they do.
    */
    return (
      <div className="space-y-6">
        <div>
          <Link
            to="/charges"
            className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="size-4" /> Charges
          </Link>
          <Skeleton className="mt-1.5 h-7 w-72 max-w-full" />
          <Skeleton className="mt-1.5 h-4 w-64" />
        </div>
        <StatTiles
          stats={[
            { label: "Energy added", value: "–", hint: null },
            { label: "Duration", value: "–" },
            { label: "Battery", value: "–", hint: null },
            { label: "Cost", value: "–", hint: null },
            ...EXTREME_TILE_LABELS.map((label) => ({ label, value: "–", hint: null })),
          ]}
        />
        {/* Same arithmetic as the drive page's chart card: header row, chip row
            and a 320px panel come to 462px on one line of chips. */}
        <Skeleton className="h-[462px] rounded-xl" />
        <div className="grid gap-6 lg:grid-cols-2">
          {Array.from({ length: 2 }, (_, card) => (
            <Skeleton key={card} className="h-60 rounded-xl" />
          ))}
        </div>
      </div>
    );
  }
  if (charge.isError || !charge.data) return <p className="text-sm text-destructive">Charging session not found.</p>;

  const units = settings.data;
  const c = charge.data;

  const toDistance = (km: number | null) =>
    km == null
      ? null
      : units.unitOfLength === "mi"
        ? Math.round(km * 0.62137119223733 * 10) / 10
        : Math.round(km * 10) / 10;
  const toTemp = (celsius: number | null) =>
    celsius == null ? null : units.unitOfTemperature === "F" ? Math.round(((celsius * 9) / 5 + 32) * 10) / 10 : celsius;

  const overTime = c.samples.map((s) => ({
    at: s.at,
    power: s.powerKw,
    battery: s.batteryLevel,
    energy: Math.round(s.energyAddedKwh * 10) / 10,
    range: toDistance(s.rangeKm),
    voltage: s.voltage,
    current: s.current,
    tempMin: toTemp(s.batteryTempMin),
    tempMax: toTemp(s.batteryTempMax),
  }));

  // Chips are only offered for readings the session has — a line that would
  // never draw is worse than no chip, and the pack temperatures in particular
  // only exist for sources that measure the modules.
  const hasSupply = c.samples.some((s) => s.voltage != null || s.current != null);
  const hasPackTemp = c.samples.some((s) => s.batteryTempMin != null || s.batteryTempMax != null);
  const tempUnit = `°${units.unitOfTemperature}`;

  const efficiency =
    c.energyAddedKwh != null && c.energyUsedKwh != null && c.energyUsedKwh > 0
      ? (c.energyAddedKwh / c.energyUsedKwh) * 100
      : null;

  const chipDefs: Record<ChargeChartSeriesKey, { label: string; color: string }> = {
    power: { label: "Power", color: CHART_COLORS.amber },
    battery: { label: "Battery", color: CHART_COLORS.green },
    energy: { label: "Energy", color: CHART_COLORS.blue },
    range: { label: "Range", color: CHART_COLORS.teal },
    voltage: { label: "Voltage", color: CHART_COLORS.violet },
    current: { label: "Current", color: CHART_COLORS.bronze },
    packTemp: { label: "Pack temp", color: CHART_COLORS.red },
  };
  const offered = CHARGE_CHART_SERIES.filter(
    (key) => (key !== "voltage" && key !== "current" ? true : hasSupply) && (key !== "packTemp" || hasPackTemp),
  );
  /**
   * Against state of charge the battery *is* the axis, so its chip sits the
   * mode out — disabled rather than hidden, keeping its place and its stored
   * preference for the switch back to time.
   */
  const isAxis = (key: ChargeChartSeriesKey) => chart.xAxis === "soc" && key === "battery";
  const active = chart.series.filter((key) => offered.includes(key) && !isAxis(key));

  /**
   * A chip is usually one series; pack temperature is two — coldest and warmest
   * module — drawn in one color and sharing one scale (`scaleGroup`), because
   * the gap between them is the thing being read. The axis shape follows the
   * chip count, per §3.8's composite rule: alone → the left axis, colored; a
   * pair of chips → left and right; more → own full-height scales, no axes.
   */
  const seriesFor = (key: ChargeChartSeriesKey, index: number): Series[] => {
    const mode = {
      axis: active.length === 2 && index === 1 ? ("right" as const) : ("left" as const),
      ownScale: active.length > 2,
    };
    if (key === "packTemp") {
      const shared = { color: chipDefs.packTemp.color, unit: tempUnit, scaleGroup: "packTemp", ...mode };
      return [
        { key: "tempMax", label: "Warmest module", ...shared },
        { key: "tempMin", label: "Coldest module", ...shared },
      ];
    }
    const unit = {
      power: "kW",
      battery: "%",
      energy: "kWh",
      range: units.unitOfLength,
      voltage: "V",
      current: "A",
    }[key];
    return [{ key, label: chipDefs[key].label, color: chipDefs[key].color, unit, ...mode }];
  };
  const compositeSeries = active.flatMap(seriesFor);

  /*
    Both x-modes get explicit bounds so the axis is proportional — against state
    of charge especially, where the taper packs many samples into the last few
    percent. A session that never moved a percent falls back to categorical.
  */
  const spanOf = (values: number[]): [number, number] | undefined => {
    if (values.length < 2) return undefined;
    const first = values[0]!;
    const last = values[values.length - 1]!;
    return first === last ? undefined : [first, last];
  };
  const bySoc = overTime.filter((s) => s.battery != null);
  const xRows = chart.xAxis === "time" ? overTime : bySoc;
  const xDomain = chart.xAxis === "time" ? spanOf(overTime.map((s) => s.at)) : spanOf(bySoc.map((s) => s.battery!));
  const xFormatter =
    chart.xAxis === "time"
      ? (value: number) => formatDate(value, "time", units.timezone)
      : (value: number) => `${value}%`;

  // Extremes for the tiles. Max power comes off the session row; the average is
  // energy drawn over the plugged-in time, which is what the house circuit felt.
  const avgPowerKw =
    c.energyUsedKwh != null && c.durationMin != null && c.durationMin > 0
      ? (c.energyUsedKwh / c.durationMin) * 60
      : null;
  const explanation = costExplanation(c, units.currency);
  const kwhLost =
    c.energyAddedKwh != null && c.energyUsedKwh != null && c.energyUsedKwh > c.energyAddedKwh
      ? c.energyUsedKwh - c.energyAddedKwh
      : null;
  // Compared as displayed, like the drive page: two readings a hundredth apart
  // print as the same figure, and a span that is one number says nothing.
  const outsideSamples = c.samples.map((s) => s.outsideTemp).filter((value): value is number => value != null);
  const outsideSpan = (() => {
    if (outsideSamples.length === 0) return null;
    const low = number(toTemp(Math.min(...outsideSamples))!, 1);
    const high = Math.max(...outsideSamples);
    return low === number(toTemp(high)!, 1) ? null : `${low} – ${u.temperature(high, units)}`;
  })();

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <Link
            to="/charges"
            className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="size-4" /> Charges
          </Link>
          <div className="mt-1 flex items-center gap-3">
            <h1 className="font-display text-[1.75rem] font-semibold leading-tight tracking-[-0.02em] text-balance sm:text-3xl">
              {c.label ?? "Charging session"}
            </h1>
            {!c.reconstructed && (
              <Badge variant={c.currentType === "dc" ? "default" : "secondary"}>{c.currentType.toUpperCase()}</Badge>
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            {eventDateline(c, units.timezone)}
            {c.addressDisplayName && ` · ${c.addressDisplayName}`}
            {c.reconstructed && (
              <>
                {" "}
                <ReconstructedBadge kind="charge" />
              </>
            )}
          </p>
          {c.reconstructed && (
            <p className="mt-2 max-w-prose text-sm text-muted-foreground">
              Nobody saw this charge. The state of charge rose from {c.startBatteryLevel ?? "?"} to{" "}
              {c.endBatteryLevel ?? "?"}% while EVBook could not read the car, so when it charged, for how long and how
              much energy it took are unknown.
              {c.costCents != null && " The cost is what the place's tariff makes of that rise."}
            </p>
          )}
        </div>
        <a
          href={`/api/v1/charges/${c.id}/csv`}
          className="inline-flex h-9 items-center gap-2 rounded-md border bg-card px-4 text-sm font-medium shadow-card transition-colors hover:border-input hover:bg-muted/60 [&_svg]:size-4"
        >
          <Download /> CSV
        </a>
      </div>

      <StatTiles
        stats={[
          { label: "Energy added", value: u.energy(c.energyAddedKwh), hint: `${u.energy(c.energyUsedKwh)} drawn` },
          { label: "Duration", value: eventDuration(c, u.duration) },
          {
            label: "Battery",
            value:
              c.startBatteryLevel != null && c.endBatteryLevel != null
                ? `${c.startBatteryLevel} → ${c.endBatteryLevel}%`
                : "–",
            hint: c.rangeAddedKm != null ? `${u.distance(c.rangeAddedKm, units, 1)} added` : null,
          },
          {
            label: "Cost",
            value: cost(c.costCents, units.currency, c.costMaxCents),
            hint: c.costPerKwhCents != null ? `${rate(c.costPerKwhCents, units.currency)} per kWh` : null,
          },
          {
            label: "Max power",
            value: u.power(c.maxPowerKw),
            hint: avgPowerKw != null ? `Ø ${u.power(avgPowerKw)}` : null,
          },
          {
            // At peak, not averaged: the supply is what it is, and the flat
            // minutes at the end of a session would drag an average off it.
            label: "Supply at peak",
            value: supplyAtPeak(c),
            hint: c.chargerType && c.chargerType !== "<invalid>" ? c.chargerType : null,
          },
          {
            label: "Charging efficiency",
            value: efficiency != null ? `${number(efficiency, 1)} %` : "–",
            hint: kwhLost != null ? `${number(kwhLost, 1)} kWh lost` : null,
          },
          {
            label: "Ø outside temperature",
            value: u.temperature(c.outsideTempAvg, units),
            hint: outsideSpan,
          },
        ]}
      />

      {explanation && (
        <p className="-mt-3 text-sm text-muted-foreground" data-testid="cost-explanation">
          <span className="font-medium text-foreground">Cost: </span>
          {explanation}
        </p>
      )}

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">Telemetry</CardTitle>
          <div className="inline-flex rounded-lg border bg-muted/60 p-0.5">
            {(
              [
                ["time", "Time"],
                ["soc", "Battery %"],
              ] as const
            ).map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                aria-pressed={chart.xAxis === mode}
                onClick={() => updateChart({ ...chart, xAxis: mode })}
                className={cn(
                  "rounded-md px-2.5 py-1 text-xs font-medium transition-[color,background-color,box-shadow] duration-150",
                  chart.xAxis === mode
                    ? "bg-card text-foreground shadow-card"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-1.5">
            {offered.map((key) => {
              const def = chipDefs[key];
              const on = active.includes(key);
              const sitsOut = isAxis(key);
              return (
                <button
                  key={key}
                  type="button"
                  aria-pressed={on}
                  disabled={sitsOut}
                  title={sitsOut ? "Battery is the x-axis in this view" : undefined}
                  onClick={() => toggleSeries(key)}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
                    // The dot wears the series color; the words stay in text ink.
                    on ? "text-foreground" : "border-input text-muted-foreground hover:text-foreground",
                    sitsOut && "opacity-50 hover:text-muted-foreground",
                  )}
                  style={on ? { borderColor: def.color, backgroundColor: `${def.color}1a` } : undefined}
                >
                  <span
                    aria-hidden
                    className="size-2 rounded-full"
                    style={{ backgroundColor: on ? def.color : "var(--border)" }}
                  />
                  {def.label}
                </button>
              );
            })}
          </div>
          {active.length > 0 ? (
            <SeriesChart
              data={xRows}
              series={compositeSeries}
              xKey={chart.xAxis === "time" ? "at" : "battery"}
              xFormatter={xFormatter}
              xDomain={xDomain}
              coloredAxes
              height={320}
            />
          ) : (
            <p className="flex h-80 items-center justify-center text-sm text-muted-foreground">
              Everything is switched off — pick a parameter above.
            </p>
          )}
        </CardContent>
      </Card>

      {/* The place and its price side by side: the map says where the session
          happened, the editor prices it — one look answers both. */}
      <div className="grid gap-6 lg:grid-cols-2">
        {c.latitude != null && c.longitude != null && (
          <Card className="overflow-hidden">
            <CarMap latitude={c.latitude} longitude={c.longitude} className="h-full min-h-56 w-full" zoom={14} />
          </Card>
        )}
        <CostEditor charge={c} currency={units.currency} />
      </div>
    </div>
  );
}
