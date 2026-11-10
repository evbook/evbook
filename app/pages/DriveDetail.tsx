import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import { ArrowLeft, Download, Plus } from "lucide-react";
import type { DriveDetailDto } from "@shared/api-types";
import { api } from "@/lib/api";
import * as u from "@/lib/units";
import { dateTime, number, timeOnly } from "@/lib/format";
import {
  DEFAULT_DRIVE_CHART,
  DRIVE_CHART_SERIES,
  readDriveChart,
  saveDriveChart,
  type DriveChartPrefs,
  type DriveChartSeriesKey,
} from "@/lib/driveChartStore";
import { cn } from "@/lib/utils";
import { useAppSettings } from "@/hooks/useAppSettings";
import { PlacePair } from "@/components/Place";
import { RouteMap, type RouteCursorHandle } from "@/components/RouteMap";
import { CHART_COLORS, SeriesChart, type Series } from "@/components/SeriesChart";
import { StatTiles } from "@/components/StatTiles";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * What sits under the consumption tile. When the drive was too short to divide by,
 * the tile reads "–", and "0.0 kWh used" beneath it would look like a fault rather
 * than a refusal — so say which it is, and at a precision that can show the tiny
 * amount a shunt up the driveway actually costs.
 */
function consumptionHint(drive: DriveDetailDto): string | null {
  if (drive.energyUsedKwh == null) return drive.consumptionKwhPer100km == null ? "too short to rate" : null;
  const digits = drive.consumptionKwhPer100km == null ? 2 : 1;
  const used = `${number(drive.energyUsedKwh, digits)} kWh used`;
  return drive.consumptionKwhPer100km == null ? `${used}, too short to rate` : used;
}

/**
 * The two ends of a drive that could still become geo-fences: each with a spot to
 * put the pin on and not already inside one. The label rides along as the name
 * the form opens with — it is the address the endpoint already goes by.
 */
function geofenceOffers(drive: DriveDetailDto) {
  const offers = [
    {
      key: "start",
      where: "start",
      lat: drive.startLatitude,
      lon: drive.startLongitude,
      fence: drive.startGeofenceId,
      label: drive.startLabel,
    },
    {
      key: "end",
      where: "destination",
      lat: drive.endLatitude,
      lon: drive.endLongitude,
      fence: drive.endGeofenceId,
      label: drive.endLabel,
    },
  ];
  return offers
    .filter((o) => o.lat != null && o.lon != null && o.fence == null)
    .map((o) => {
      const params = new URLSearchParams({ lat: String(o.lat), lon: String(o.lon) });
      if (o.label && o.label !== "Unknown") params.set("name", o.label);
      return { key: o.key, where: o.where, label: o.label, href: `/geofences/new?${params.toString()}` };
    });
}

/** The second row of tiles, in the skeleton and the loaded page alike. */
const EXTREME_TILE_LABELS = ["Max speed", "Max power", "Ø outside temperature", "Ø inside temperature"] as const;

export function DriveDetailPage() {
  const { id } = useParams();
  const settings = useAppSettings();
  const drive = useQuery({
    queryKey: ["drive", id],
    queryFn: () => api<DriveDetailDto>(`/api/v1/drives/${id}`),
    enabled: Boolean(id),
  });
  // How the telemetry chart was last set up — on any drive; it is a way of
  // reading, not a fact about this one — restored once at mount.
  const [chart, setChart] = useState(() => readDriveChart() ?? DEFAULT_DRIVE_CHART);
  // The map fills this with its cursor setter; chart hovers call straight into it.
  const routeCursor = useRef<RouteCursorHandle | null>(null);
  const updateChart = (next: DriveChartPrefs) => {
    saveDriveChart(next);
    setChart(next);
  };
  // One pass through the canonical list both flips the key and keeps the stored
  // set in canonical order, so which series holds which axis never depends on
  // the order things were clicked in.
  const toggleSeries = (key: DriveChartSeriesKey) =>
    updateChart({
      ...chart,
      series: DRIVE_CHART_SERIES.filter((k) => (k === key ? !chart.series.includes(k) : chart.series.includes(k))),
    });

  if (!settings.data || drive.isLoading) {
    /*
      The loaded page's own frame: back link, tile labels, the map card, and the
      full-width chart card, each at its final size. Only the words and lines are
      still to come, so nothing moves when they do.
    */
    return (
      <div className="space-y-6">
        <div>
          <Link
            to="/drives"
            className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="size-4" /> Drives
          </Link>
          <Skeleton className="mt-1.5 h-7 w-72 max-w-full" />
          <Skeleton className="mt-1.5 h-4 w-48" />
        </div>
        <StatTiles
          stats={[
            { label: "Distance", value: "–" },
            { label: "Duration", value: "–" },
            { label: "Consumption", value: "–", hint: null },
            { label: "Battery", value: "–", hint: null },
            ...EXTREME_TILE_LABELS.map((label) => ({ label, value: "–", hint: null })),
          ]}
        />
        <Card className="overflow-hidden">
          <Skeleton className="h-72 w-full rounded-none" />
        </Card>
        {/* Header row, chip row and a 320px panel come to 462px on one line of
            chips — the desktop shape; narrow screens wrap chips and run taller. */}
        <Skeleton className="h-[462px] rounded-xl" />
      </div>
    );
  }
  if (drive.isError || !drive.data) {
    return <p className="text-sm text-destructive">Drive not found.</p>;
  }

  const units = settings.data;
  const d = drive.data;
  const offers = geofenceOffers(d);

  // Convert once for the charts so the axes match the user's units.
  const toDistance = (km: number | null) =>
    km == null
      ? null
      : units.unitOfLength === "mi"
        ? Math.round(km * 0.62137119223733 * 10) / 10
        : Math.round(km * 10) / 10;
  const toTemp = (c: number | null) =>
    c == null ? null : units.unitOfTemperature === "F" ? Math.round(((c * 9) / 5 + 32) * 10) / 10 : c;

  const chartData = d.positions.map((p) => ({
    at: p.at,
    // Unrounded, unlike the y-values: this is an x-coordinate, and rounding to a
    // tenth would stack a town's worth of samples onto one vertical line.
    distance:
      p.odometerKm != null && d.startKm != null
        ? Math.max(0, p.odometerKm - d.startKm) * (units.unitOfLength === "mi" ? 0.62137119223733 : 1)
        : null,
    speed: toDistance(p.speedKmh),
    power: p.powerKw,
    battery: p.batteryLevel,
    range: toDistance(p.rangeKm),
    outside: toTemp(p.outsideTemp),
    inside: toTemp(p.insideTemp),
    elevation: p.elevation,
  }));

  // Chart rows and positions align by index against time, but not against
  // distance — rows without an odometer are filtered out there — so a hovered row
  // finds its position by timestamp instead.
  const positionIndexByAt = new Map(d.positions.map((p, index) => [p.at, index]));
  const hoverPosition = (row: Record<string, number | null> | null) =>
    routeCursor.current?.(row?.at != null ? (positionIndexByAt.get(row.at) ?? null) : null);

  const formatTime = (value: number) => timeOnly(value, units.timezone);
  const speedUnit = units.unitOfLength === "mi" ? "mph" : "km/h";
  const hasElevation = d.positions.some((p) => p.elevation != null);

  const seriesDefs: Record<DriveChartSeriesKey, { label: string; color: string; unit: string }> = {
    speed: { label: "Speed", color: CHART_COLORS.blue, unit: speedUnit },
    power: { label: "Power", color: CHART_COLORS.amber, unit: "kW" },
    battery: { label: "Battery", color: CHART_COLORS.green, unit: "%" },
    range: { label: "Range", color: CHART_COLORS.teal, unit: units.unitOfLength },
    elevation: { label: "Elevation", color: CHART_COLORS.bronze, unit: "m" },
    outside: { label: "Outside", color: CHART_COLORS.violet, unit: `°${units.unitOfTemperature}` },
    inside: { label: "Inside", color: CHART_COLORS.red, unit: `°${units.unitOfTemperature}` },
  };
  // A drive without elevation samples (imported history) drops the chip rather
  // than offering a line that would never draw.
  const offered = DRIVE_CHART_SERIES.filter((key) => key !== "elevation" || hasElevation);
  const active = chart.series.filter((key) => offered.includes(key));

  /**
   * The axis shape follows how many series are on, per §3.8's composite rule:
   * alone → the left axis, in the line's color; a pair → left and right, each
   * colored; more → every line on its own full-height scale and no axes at all,
   * the figures staying in the tooltip.
   */
  const compositeSeries: Series[] = active.map((key, index) => ({
    key,
    ...seriesDefs[key],
    axis: active.length === 2 && index === 1 ? ("right" as const) : ("left" as const),
    ownScale: active.length > 2,
  }));

  /*
    Both x-modes get explicit bounds so the axis is proportional — against the
    odometer especially, where a traffic jam packs many samples into a few metres
    and a categorical axis would stretch the jam to look like most of the trip.
  */
  const spanOf = (values: number[]): [number, number] | undefined =>
    values.length >= 2 ? [values[0]!, values[values.length - 1]!] : undefined;
  const byDistance = chartData.filter((p) => p.distance != null);
  const xRows = chart.xAxis === "time" ? chartData : byDistance;
  const xDomain =
    chart.xAxis === "time" ? spanOf(chartData.map((p) => p.at)) : spanOf(byDistance.map((p) => p.distance!));
  const xFormatter =
    chart.xAxis === "time" ? formatTime : (value: number) => `${number(value, 1)} ${units.unitOfLength}`;

  // Extremes for the tiles. Max speed and max power come off the drive row, which
  // saw every sample; the rest are read from the (down-sampled) chart positions.
  const samples = (read: (p: (typeof d.positions)[number]) => number | null) =>
    d.positions.map(read).filter((value): value is number => value != null);
  // "17.4 – 17.4 °C" under a 17.4 °C average says nothing; a hint that is the
  // whole range only earns its line when the drive visibly spanned one — compared
  // as displayed, since two readings a hundredth apart print as the same figure.
  const tempSpan = (values: number[]) => {
    if (values.length === 0) return null;
    const low = number(toTemp(Math.min(...values))!, 1);
    const high = Math.max(...values);
    return low === number(toTemp(high)!, 1) ? null : `${low} – ${u.temperature(high, units)}`;
  };
  const powers = samples((p) => p.powerKw);
  const powerMin = powers.length > 0 ? Math.min(...powers) : null;
  const avgSpeedKmh =
    d.distanceKm != null && d.durationMin != null && d.durationMin > 0 ? (d.distanceKm / d.durationMin) * 60 : null;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <Link
            to="/drives"
            className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="size-4" /> Drives
          </Link>
          <h1 className="mt-1.5 font-display text-[1.75rem] font-semibold leading-tight tracking-[-0.02em] text-balance sm:text-3xl">
            <PlacePair
              startLabel={d.startLabel}
              startRegion={d.startRegion}
              endLabel={d.endLabel}
              endRegion={d.endRegion}
              startFallback="Drive"
              endFallback="?"
            />
          </h1>
          <p className="text-sm text-muted-foreground">
            {dateTime(d.startAt, units.timezone)} – {timeOnly(d.endAt, units.timezone)}
          </p>
        </div>
        <a
          href={`/api/v1/drives/${d.id}/gpx`}
          className="inline-flex h-9 items-center gap-2 rounded-md border bg-card px-4 text-sm font-medium shadow-card transition-colors hover:border-input hover:bg-muted/60 [&_svg]:size-4"
        >
          <Download /> GPX
        </a>
      </div>

      <StatTiles
        stats={[
          { label: "Distance", value: u.distance(d.distanceKm, units, 1) },
          { label: "Duration", value: u.duration(d.durationMin != null ? d.durationMin * 60 : null) },
          {
            label: "Consumption",
            value: d.consumptionKwhPer100km != null ? u.consumption(d.consumptionKwhPer100km, units) : "–",
            hint: consumptionHint(d),
          },
          {
            label: "Battery",
            value:
              d.startBatteryLevel != null && d.endBatteryLevel != null
                ? `${d.startBatteryLevel} → ${d.endBatteryLevel}%`
                : "–",
            hint:
              d.startRangeKm != null && d.endRangeKm != null
                ? `${u.distance(d.startRangeKm - d.endRangeKm, units, 1)} of range`
                : null,
          },
          {
            label: "Max speed",
            value: u.speed(d.speedMaxKmh, units),
            hint: avgSpeedKmh != null ? `Ø ${u.speed(avgSpeedKmh, units)}` : null,
          },
          {
            label: "Max power",
            value: u.power(d.powerMaxKw),
            // The other end of the pedal: the deepest regen the samples caught.
            hint: powerMin != null ? (powerMin < 0 ? `${u.power(powerMin)} regen` : `min ${u.power(powerMin)}`) : null,
          },
          {
            label: "Ø outside temperature",
            value: u.temperature(d.outsideTempAvg, units),
            hint: tempSpan(samples((p) => p.outsideTemp)),
          },
          {
            label: "Ø inside temperature",
            value: u.temperature(d.insideTempAvg, units),
            hint: tempSpan(samples((p) => p.insideTemp)),
          },
        ]}
      />

      <Card className="overflow-hidden">
        <RouteMap points={d.positions} className="h-72 w-full" cursorRef={routeCursor} />
        {offers.length > 0 && (
          <div className="flex flex-wrap gap-2 p-4">
            {offers.map((offer) => (
              <Link
                key={offer.key}
                to={offer.href}
                title={`Add a geo-fence where this drive's ${offer.where} is`}
                className="inline-flex items-center gap-1.5 rounded-md border border-dashed px-3 py-1.5 text-xs transition-colors hover:bg-accent [&_svg]:size-3.5"
              >
                <Plus />
                Geo-fence at {offer.where}
                {offer.label && <span className="text-muted-foreground">{`·\u00A0${offer.label}`}</span>}
              </Link>
            ))}
          </div>
        )}
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">Telemetry</CardTitle>
          <div className="inline-flex rounded-lg border bg-muted/60 p-0.5">
            {(
              [
                ["time", "Time"],
                ["distance", "Distance"],
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
              const def = seriesDefs[key];
              const on = active.includes(key);
              return (
                <button
                  key={key}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggleSeries(key)}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
                    // The dot wears the series color; the words stay in text ink.
                    on ? "text-foreground" : "border-input text-muted-foreground hover:text-foreground",
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
              xKey={chart.xAxis === "time" ? "at" : "distance"}
              xFormatter={xFormatter}
              xDomain={xDomain}
              coloredAxes
              height={320}
              onHover={hoverPosition}
            />
          ) : (
            <p className="flex h-80 items-center justify-center text-sm text-muted-foreground">
              Everything is switched off — pick a parameter above.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
