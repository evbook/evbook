import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type {
  BatteryHealthDto,
  EfficiencyStatsDto,
  OdometerSeriesDto,
  UpdateDto,
  VampireDrainDto,
} from "@shared/api-types";
import { api } from "@/lib/api";
import * as u from "@/lib/units";
import { dateTime, number } from "@/lib/format";
import { PENDING_SETTINGS, useAppSettings, useCars } from "@/hooks/useAppSettings";
import { useCarChoice } from "@/hooks/useCarChoice";
import { CHART_COLORS, SeriesChart, type Series } from "@/components/SeriesChart";
import { SkeletonRows } from "@/components/TableSkeleton";
import { StatTiles } from "@/components/StatTiles";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PageHeader } from "@/components/PageHeader";
import { InfoTip } from "@/components/InfoTip";
import { cn } from "@/lib/utils";

/**
 * The middle gap between installs, or null until there are two to compare. Median
 * rather than mean: firmware arrives in bursts and then not at all for a quarter,
 * and one such quarter drags a mean well off where the typical wait actually is.
 */
function medianGap(updates: UpdateDto[] | undefined): number | null {
  const gaps = (updates ?? [])
    .map((update) => update.daysSincePrevious)
    .filter((days): days is number => days != null)
    .sort((a, b) => a - b);
  // Two gaps, not one: "typically" is a claim about a pattern, and a single
  // interval between two installs is not one.
  if (gaps.length < 2) return null;
  const middle = Math.floor(gaps.length / 2);
  return gaps.length % 2 === 1 ? gaps[middle]! : (gaps[middle - 1]! + gaps[middle]!) / 2;
}

export function HealthPage() {
  const cars = useCars();
  const settings = useAppSettings();
  const [selected, setSelected] = useCarChoice();
  // Which way the capacity estimates are spread out — against the calendar or the
  // odometer. One chart with a switch rather than two side by side: they are the
  // same measurements either way, and two panels read as two different ones.
  const [capacityAxis, setCapacityAxis] = useState<"time" | "mileage">("time");

  // This page has no all-cars view — every figure on it is about one pack — so an empty
  // choice, remembered from a page that does, falls back to the first car as before.
  const carId = selected || (cars.data?.[0]?.id != null ? String(cars.data[0].id) : "");

  const health = useQuery({
    queryKey: ["battery-health", carId],
    queryFn: () => api<BatteryHealthDto>(`/api/v1/stats/battery-health?carId=${carId}`),
    enabled: Boolean(carId),
  });
  const drain = useQuery({
    queryKey: ["vampire-drain", carId],
    queryFn: () => api<VampireDrainDto>(`/api/v1/stats/vampire-drain?carId=${carId}&minHours=4`),
    enabled: Boolean(carId),
  });
  const updates = useQuery({
    queryKey: ["updates", carId],
    queryFn: () => api<UpdateDto[]>(`/api/v1/stats/updates?carId=${carId}`),
    enabled: Boolean(carId),
  });
  const efficiency = useQuery({
    queryKey: ["efficiency", carId],
    queryFn: () => api<EfficiencyStatsDto>(`/api/v1/stats/efficiency?carId=${carId}`),
    enabled: Boolean(carId),
  });
  const odometer = useQuery({
    queryKey: ["odometer", carId],
    queryFn: () => api<OdometerSeriesDto>(`/api/v1/stats/odometer?carId=${carId}`),
    enabled: Boolean(carId),
  });

  /*
    The frame — heading, tiles, card headers, table headers — is drawn before any
    request answers, so the page opens at its final shape and only the figures
    fill in. Each query's data is withheld until settings are in too, so nothing
    real is ever formatted with the pending units.
  */
  const pending = settings.data == null;
  const units = settings.data ?? PENDING_SETTINGS;
  const healthData = pending ? undefined : health.data;
  const drainData = pending ? undefined : drain.data;
  const updatesData = pending ? undefined : updates.data;
  const efficiencyData = pending ? undefined : efficiency.data;
  const odometerSeries = pending ? undefined : odometer.data;

  const toDistance = (km: number | null) =>
    km == null ? null : units.unitOfLength === "mi" ? Math.round(km * 0.62137119223733) : Math.round(km);

  /*
    Temperature bands are labelled by the band floor in °C even when distances are in
    miles: the app has no Fahrenheit-per-band conversion that would keep 5° bands
    whole, and relabelling them without rebanding would be a lie. Consumption is
    converted, since it is per unit of distance.
  */
  const tempBands = (efficiencyData?.bands ?? []).map((band) => ({
    from: band.fromCelsius,
    consumption: (() => {
      const value = u.consumptionValue(band.consumptionKwhPer100km, units);
      return value == null ? null : Math.round(value);
    })(),
  }));

  const odometerData = (odometerSeries?.points ?? []).map((point) => ({
    at: point.at,
    odometer: toDistance(point.odometerKm),
  }));
  // Proportional axis, so a stretch with nothing logged stays a gap rather than
  // being squeezed out — the same reason the charge-level chart passes a domain.
  const odometerDomain: [number, number] | undefined =
    odometerSeries == null ? undefined : [odometerSeries.from, odometerSeries.to];

  // The same colors on either x-axis: the series keep their identity when the
  // reader flips the switch, so a palette change would say the data changed too.
  const capacitySeries: Series[] = [
    { key: "capacity", label: "Capacity", color: CHART_COLORS.green, unit: "kWh" },
    {
      key: "range",
      label: "Range at 100%",
      color: CHART_COLORS.teal,
      unit: units.unitOfLength,
      axis: "right",
    },
  ];
  const byTime = (healthData?.points ?? []).map((p) => ({
    at: p.at,
    capacity: Math.round(p.capacityKwh * 10) / 10,
    range: toDistance(p.rangeAt100Km),
  }));
  const byOdometer = (healthData?.points ?? [])
    .filter((p) => p.odometerKm != null)
    .map((p) => ({
      odometer: toDistance(p.odometerKm)!,
      capacity: Math.round(p.capacityKwh * 10) / 10,
      range: toDistance(p.rangeAt100Km),
    }));
  /*
    Proportional axes, never categorical: the sessions are the same set in the same
    order in both modes, so evenly spaced samples would draw the identical polyline
    twice and the switch would change nothing but the tick labels. Time and mileage
    disagree about where the sessions sit — a road-trip week is a sliver of the
    calendar and a stride of the odometer — and that disagreement is what the
    switch is for.
  */
  const spanOf = (values: number[]): [number, number] | undefined =>
    values.length >= 2 ? [values[0]!, values[values.length - 1]!] : undefined;
  const timeDomain = spanOf(byTime.map((p) => p.at));
  const odometerXDomain = spanOf(byOdometer.map((p) => p.odometer));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Health"
        description="How the pack and the car are holding up over time."
        info={
          <InfoTip label="How capacity is measured">
            <p>
              Capacity is measured from charging sessions — between exact percent-level transitions where samples exist
              — skipping sessions spent heating a cold pack, and fitted over a recent window so a cold snap doesn't read
              as lost capacity.
            </p>
            <p>
              On the capacity chart each session's estimate is a faint point and the line is the trend through them: a
              pack does not lose and regain a kilowatt-hour week to week, so the zigzag between points is the
              measurement, not the battery.
            </p>
          </InfoTip>
        }
      />

      {(cars.data?.length ?? 0) > 1 && (
        <div className="space-y-1.5">
          <Label htmlFor="car">Car</Label>
          <Select id="car" className="w-44" value={carId} onChange={(e) => setSelected(e.target.value)}>
            {cars.data?.map((car) => (
              <option key={car.id} value={car.id}>
                {car.name ?? `VIN …${car.vin.slice(-6)}`}
              </option>
            ))}
          </Select>
        </div>
      )}

      <StatTiles
        stats={[
          {
            label: "Usable capacity",
            value: healthData?.currentCapacityKwh != null ? `${number(healthData.currentCapacityKwh, 1)} kWh` : "–",
            // The pack when new (the VIN's figure) beats the first sessions on
            // record as a reference: logging usually starts years into a car's
            // life, so "first measured" already has loss baked in.
            hint:
              healthData?.newCapacityKwh != null
                ? `of ≈ ${number(healthData.newCapacityKwh, 0)} kWh when new`
                : healthData?.originalCapacityKwh != null
                  ? `${number(healthData.originalCapacityKwh, 1)} kWh when first measured`
                  : null,
          },
          (() => {
            // Since-new when the VIN pins the pack down, since-first-measured
            // otherwise. A figure at or below zero means measurements came out
            // above the baseline — no loss detected, not a gain.
            const sinceNew = healthData?.degradationFromNewPercent;
            const loss = sinceNew ?? healthData?.degradationPercent;
            return {
              label: "Degradation",
              // The since-new figure carries the same ≈ as the capacity it is
              // measured against.
              value:
                loss == null ? "–" : loss <= 0 ? "None yet" : `${sinceNew != null ? "≈ " : ""}${number(loss, 1)} %`,
              hint:
                loss == null
                  ? null
                  : sinceNew != null
                    ? "vs the pack when new"
                    : loss <= 0
                      ? "No loss measured so far"
                      : "vs the first sessions on record",
            };
          })(),
          {
            label: "Range at 100%",
            value: u.distance(healthData?.currentRangeAt100Km, units),
          },
          {
            label: "Idle loss",
            value:
              drainData?.averageLossPerHourKm != null
                ? `${u.distance(drainData.averageLossPerHourKm, units, 2)}/h`
                : "–",
          },
        ]}
      />

      {/* Only the loaded-and-thin case collapses to a note; while loading, the
          capacity card holds its final shape and the chart fills in. */}
      {!(health.isLoading || pending) && (healthData?.points.length ?? 0) < 2 ? (
        <Card>
          <CardContent className="pt-6 text-sm text-muted-foreground">
            Not enough charging sessions yet to estimate capacity. A few sessions that add 10% or more will do it.
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle className="text-base">Capacity</CardTitle>
            <div className="inline-flex rounded-lg border bg-muted/60 p-0.5">
              {(
                [
                  ["time", "Time"],
                  ["mileage", "Mileage"],
                ] as const
              ).map(([mode, label]) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={capacityAxis === mode}
                  onClick={() => setCapacityAxis(mode)}
                  className={cn(
                    "rounded-md px-2.5 py-1 text-xs font-medium transition-[color,background-color,box-shadow] duration-150",
                    capacityAxis === mode
                      ? "bg-card text-foreground shadow-card"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </CardHeader>
          <CardContent>
            {health.isLoading || pending ? (
              <Skeleton className="h-[220px]" />
            ) : (
              <SeriesChart
                data={capacityAxis === "time" ? byTime : byOdometer}
                smooth
                xKey={capacityAxis === "time" ? "at" : "odometer"}
                xDomain={capacityAxis === "time" ? timeDomain : odometerXDomain}
                xFormatter={
                  capacityAxis === "time"
                    ? (value) => dateTime(value, units.timezone).split(",")[0] ?? ""
                    : (value) => `${value.toLocaleString()} ${units.unitOfLength}`
                }
                series={capacitySeries}
              />
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <div className="flex items-center gap-1.5">
            <CardTitle className="text-base">Range vs Temperature</CardTitle>
            <InfoTip label="Why this panel">
              Range that drops every winter and comes back every spring is the weather, not the pack — this is the panel
              that tells the two apart.
            </InfoTip>
          </div>
          <CardDescription>Consumption by outside temperature over the last year.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
            {[
              ["Net, from the pack", efficiencyData?.netKwhPer100km, "what the driving used"],
              ["Gross, from the wall", efficiencyData?.grossKwhPer100km, "what it cost to put back"],
            ].map(([label, value, hint]) => (
              <div key={String(label)} className="border-b pb-2">
                <dt className="text-muted-foreground">{String(label)}</dt>
                <dd className="font-medium tabular-nums">
                  {typeof value === "number" ? u.consumption(value, units) : "–"}
                </dd>
                <dd className="text-xs text-muted-foreground">{String(hint)}</dd>
              </div>
            ))}
            <div className="border-b pb-2">
              <dt className="text-muted-foreground">Lost while charging</dt>
              <dd className="font-medium tabular-nums">
                {efficiencyData?.chargingLossShare != null
                  ? `${Math.round(efficiencyData.chargingLossShare * 100)} %`
                  : "–"}
              </dd>
              <dd className="text-xs text-muted-foreground">never reached the pack</dd>
            </div>
          </dl>

          {efficiency.isLoading || pending ? (
            <Skeleton className="h-[200px]" />
          ) : (efficiencyData?.bands.length ?? 0) === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No drives with a temperature reading yet.</p>
          ) : (
            <SeriesChart
              data={tempBands}
              xKey="from"
              xFormatter={(value) => `${value}°`}
              series={[
                {
                  key: "consumption",
                  label: "Consumption",
                  color: CHART_COLORS.blue,
                  unit: `Wh/${units.unitOfLength}`,
                  // The fill under the line is the range the cold is eating: the
                  // ink grows where driving gets expensive, which is the point of
                  // the panel.
                  gradient: true,
                },
              ]}
              height={200}
            />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-1.5">
            <CardTitle className="text-base">Mileage over time</CardTitle>
            <InfoTip label="Reading the line">
              A straight line is a predictable routine; a kink is a road trip or a change of habits.
            </InfoTip>
          </div>
          <CardDescription>The odometer over the last year.</CardDescription>
        </CardHeader>
        <CardContent>
          {odometer.isLoading || pending ? (
            <Skeleton className="h-[200px]" />
          ) : (
            <SeriesChart
              data={odometerData}
              xKey="at"
              xDomain={odometerDomain}
              xFormatter={(value) => dateTime(value, units.timezone).split(",")[0] ?? ""}
              series={[{ key: "odometer", label: "Odometer", color: CHART_COLORS.violet, unit: units.unitOfLength }]}
              height={200}
            />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Idle loss</CardTitle>
          <CardDescription>
            Range lost while parked for four hours or more, excluding periods that include charging.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {!(drain.isLoading || pending) && (drainData?.periods.length ?? 0) === 0 ? (
            <p className="px-6 pb-6 text-sm text-muted-foreground">No long idle periods recorded yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>From</TableHead>
                  <TableHead className="text-right">Idle</TableHead>
                  <TableHead className="text-right">Range lost</TableHead>
                  <TableHead className="text-right">Per hour</TableHead>
                  <TableHead className="text-right">SoC lost</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(drain.isLoading || pending) && <SkeletonRows columns={5} />}
                {(drainData?.periods ?? []).slice(0, 25).map((period) => (
                  <TableRow key={period.fromAt}>
                    <TableCell>{dateTime(period.fromAt, units.timezone)}</TableCell>
                    <TableCell className="text-right tabular-nums">{u.duration(period.hours * 3600)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {u.distance(period.rangeLostKm, units, 1)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {period.rangeLostPerHourKm != null ? u.distance(period.rangeLostPerHourKm, units, 2) : "–"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {period.socLost != null ? `${period.socLost}%` : "–"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Software updates</CardTitle>
          <CardDescription>
            Every firmware version this car has installed.
            {medianGap(updatesData) != null &&
              ` Installs are typically ${number(medianGap(updatesData), 0)} days apart — the median, so one long wait does not shift it.`}
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {!(updates.isLoading || pending) && (updatesData?.length ?? 0) === 0 ? (
            <p className="px-6 pb-6 text-sm text-muted-foreground">No updates recorded yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Installed</TableHead>
                  <TableHead>Version</TableHead>
                  <TableHead className="text-right">Days since previous</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(updates.isLoading || pending) && <SkeletonRows columns={3} />}
                {(updatesData ?? []).map((update) => (
                  <TableRow key={update.id}>
                    <TableCell>{dateTime(update.endAt, units.timezone)}</TableCell>
                    <TableCell className="font-medium">{update.version ?? "–"}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {update.daysSincePrevious != null ? number(update.daysSincePrevious, 0) : "–"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
