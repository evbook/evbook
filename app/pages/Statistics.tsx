import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ChargingStatsDto, DriveStatsDto, Period, PeriodStatsDto } from "@shared/api-types";
import { statsWindow } from "@shared/timeBuckets";
import { api } from "@/lib/api";
import * as u from "@/lib/units";
import { cost, money, number, rate, sumKnown } from "@/lib/format";
import { PENDING_SETTINGS, useAppSettings, useCars } from "@/hooks/useAppSettings";
import { useCarChoice } from "@/hooks/useCarChoice";
import { useRangeContext } from "@/hooks/useRangeContext";
import { CHART_COLORS, SeriesChart } from "@/components/SeriesChart";
import { Place, placeText } from "@/components/Place";
import { SkeletonRows } from "@/components/TableSkeleton";
import { StatTiles } from "@/components/StatTiles";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PageHeader } from "@/components/PageHeader";
import { InfoTip } from "@/components/InfoTip";

const HOUR = 3_600_000;

/**
 * A heatmap cell's fill: the charging colour, stronger the busier the hour, and a
 * neutral well for an hour nothing started in. A mix of the colour into the card
 * rather than opacity on a fixed one, so "stronger is busier" reads the same way
 * in both themes — the old scale faded the primary colour, which is near black
 * on a light page and near white on a dark one, so the dark theme read inverted.
 */
function heatColor(count: number, busiest: number): string {
  if (count === 0) return "color-mix(in oklch, var(--foreground) 5%, transparent)";
  const share = busiest > 0 ? count / busiest : 0;
  return `color-mix(in oklch, var(--success) ${Math.round(22 + 78 * share)}%, transparent)`;
}

export function StatisticsPage() {
  const [period, setPeriod] = useState<Period>("month");
  const [carId, setCarId] = useCarChoice();
  const settings = useAppSettings();
  const cars = useCars();
  const range = useRangeContext(settings.data?.timezone);

  /*
    One window for the whole page, sent explicitly to every card on it rather than
    left to each endpoint's own default. The roll-ups below fall back to the last
    year when asked without bounds, so an unbounded request had them answering for
    a different span than the table above them — grouping by year put a decade of
    totals beside one year of "AC vs DC" and "Top charging locations".

    Quantized to the hour, as the Overview's band is to the quarter: `range.now`
    steps every minute and these bounds reach every query key below, so following
    it to the minute would refetch the whole page sixty times an hour to move the
    edge of a window days or years wide.
  */
  const viewWindow = useMemo(() => statsWindow(period, Math.floor(range.now / HOUR) * HOUR), [period, range.now]);

  const params = new URLSearchParams({ period, from: String(viewWindow.from), to: String(viewWindow.to) });
  if (carId) params.set("carId", carId);
  // Group weeks the way the date range picker slices them, so a week selected there
  // is one bucket here rather than parts of two.
  if (period === "week") params.set("weekStart", String(range.firstDay));
  // Keyed on the query string itself, as the drives and charges lists are: the key
  // then covers everything the request depends on by construction.
  const query = params.toString();

  const rollup = new URLSearchParams({ from: String(viewWindow.from), to: String(viewWindow.to) });
  if (carId) rollup.set("carId", carId);
  const rollupQuery = rollup.toString();

  const stats = useQuery({
    queryKey: ["stats", query],
    queryFn: () => api<PeriodStatsDto>(`/api/v1/stats?${query}`),
  });
  const charging = useQuery({
    queryKey: ["stats-charging", rollupQuery],
    queryFn: () => api<ChargingStatsDto>(`/api/v1/stats/charging?${rollupQuery}`),
  });
  const drives = useQuery({
    queryKey: ["stats-drives", rollupQuery],
    queryFn: () => api<DriveStatsDto>(`/api/v1/stats/drives?${rollupQuery}`),
  });

  /*
    The frame — heading, selectors, tiles, every card and table header — is drawn
    before any request answers, so the page opens at its final shape and only the
    figures fill in. Each roll-up folds `pending` into its own loading state, so
    nothing real is ever formatted with the pending units.
  */
  const pending = settings.data == null;
  const units = settings.data ?? PENDING_SETTINGS;
  const statsLoading = stats.isLoading || pending;
  const chargingLoading = charging.isLoading || pending;
  const drivesLoading = drives.isLoading || pending;

  // Newest first in the table, oldest first in the charts.
  const buckets = (!pending && stats.data?.buckets) || [];
  const withData = buckets.filter((b) => b.driveCount > 0 || b.chargeCount > 0);
  const rows = [...withData].reverse();

  const toDistance = (km: number | null) =>
    km == null ? null : units.unitOfLength === "mi" ? Math.round(km * 0.62137119223733) : Math.round(km);

  /** Whole watt-hours, or null — a tenth of a Wh per km is below the noise. */
  const round0 = (value: number | null) => (value == null ? null : Math.round(value));

  const chartData = withData.map((b) => ({
    from: b.from,
    distance: toDistance(b.distanceKm),
    energy: b.energyChargedKwh != null ? Math.round(b.energyChargedKwh) : null,
    cost: b.costCents != null ? Math.round(b.costCents) / 100 : null,
    // Converted, not just relabelled: the axis is Wh per unit of the chosen distance.
    consumption: round0(u.consumptionValue(b.consumptionKwhPer100km, units)),
  }));

  // Bands are km/h from the API. The axis is labelled in the configured unit, so
  // the band floor is converted rather than relabelled — a "20" tick on a miles
  // chart would otherwise be a 20 km/h band wearing an mph label.
  const speedData = (drives.data?.speedBands ?? []).map((band) => ({
    from: units.unitOfLength === "mi" ? Math.round(band.fromKmh * 0.62137119223733) : band.fromKmh,
    count: band.count,
  }));

  // Each total over the buckets that have the figure; unknown when none does, so
  // a year nobody priced a charge in reads as unpriced rather than as free.
  const totals = {
    distanceKm: sumKnown(withData.map((b) => b.distanceKm)),
    energyChargedKwh: sumKnown(withData.map((b) => b.energyChargedKwh)),
    costCents: sumKnown(withData.map((b) => b.costCents)),
    durationMin: sumKnown(withData.map((b) => b.durationMin)),
  };

  const labelFor = (from: number) => withData.find((b) => b.from === from)?.label ?? "";
  // Withheld until settings are in too, so no figure is priced or measured in
  // the wrong unit while the two requests race.
  const chargingData = chargingLoading ? undefined : charging.data;
  const drivesData = drivesLoading ? undefined : drives.data;
  const ac = chargingData?.ac;
  const dc = chargingData?.dc;

  /** Cost per kWh for one side of the split, in cents, recomputed from its own two sums. */
  const perKwh = (side: typeof ac) =>
    side?.costCents != null && side.energyKwh ? side.costCents / side.energyKwh : null;

  const superchargerShare =
    chargingData?.superchargerCostCents != null && chargingData.totalCostCents
      ? chargingData.superchargerCostCents / chargingData.totalCostCents
      : null;

  const curveData = (chargingData?.dcCurve ?? []).map((point) => ({
    band: point.band,
    power: point.avgPowerKw != null ? Math.round(point.avgPowerKw) : null,
  }));

  // The heatmap is a fixed 7×24 grid, so the cells the API had nothing for have to
  // be filled in here — a sparse list would draw a lopsided week.
  const heatByCell = new Map((chargingData?.heatmap ?? []).map((cell) => [`${cell.weekday}-${cell.hour}`, cell]));
  const busiestCell = Math.max(1, ...(chargingData?.heatmap ?? []).map((cell) => cell.count));
  const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

  // How far back the chosen grouping reaches, in words. Every card says it: they
  // used to say "over the last year" or say nothing at all, and neither was true
  // of a page whose window moves with the selector above.
  const spanLabel =
    period === "day"
      ? "the last 30 days"
      : period === "week"
        ? "the last year"
        : period === "month"
          ? "the last two years"
          : "the last ten years";

  return (
    <div className="space-y-6">
      <PageHeader
        title="Statistics"
        description={
          <>
            Usage and cost over {spanLabel}, grouped by period, in {units.timezone.replace("_", " ")}.
          </>
        }
      />

      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="period">Group by</Label>
          <Select id="period" className="w-36" value={period} onChange={(e) => setPeriod(e.target.value as Period)}>
            <option value="day">Day</option>
            <option value="week">Week</option>
            <option value="month">Month</option>
            <option value="year">Year</option>
          </Select>
        </div>
        {(cars.data?.length ?? 0) > 1 && (
          <div className="space-y-1.5">
            <Label htmlFor="car">Car</Label>
            <Select id="car" className="w-44" value={carId} onChange={(e) => setCarId(e.target.value)}>
              <option value="">All cars</option>
              {cars.data?.map((car) => (
                <option key={car.id} value={car.id}>
                  {car.name ?? `VIN …${car.vin.slice(-6)}`}
                </option>
              ))}
            </Select>
          </div>
        )}
      </div>

      {/* "–" while loading, not a bold zero: an empty sum is an answer, and the
          tiles should not give it before the buckets have. */}
      <StatTiles
        stats={[
          { label: "Distance", value: statsLoading ? "–" : u.distance(totals.distanceKm, units) },
          {
            label: "Time driven",
            value: statsLoading ? "–" : u.duration(totals.durationMin != null ? totals.durationMin * 60 : null),
          },
          { label: "Energy charged", value: statsLoading ? "–" : u.energy(totals.energyChargedKwh) },
          {
            label: "Cost",
            value: statsLoading ? "–" : cost(totals.costCents, units.currency),
            hint:
              !statsLoading &&
              totals.costCents != null &&
              totals.energyChargedKwh != null &&
              totals.energyChargedKwh > 0
                ? `${rate(totals.costCents / totals.energyChargedKwh, units.currency)} per kWh`
                : null,
          },
        ]}
      />

      {/* Only the loaded-and-empty case collapses to a note; while loading, the
          two chart cards and the table hold their final shape. */}
      {!statsLoading && withData.length === 0 ? (
        <Card>
          <CardContent className="pt-6 text-sm text-muted-foreground">
            Nothing logged in this window yet. Statistics fill in as drives and charges accumulate.
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Distance and energy</CardTitle>
              </CardHeader>
              <CardContent>
                {statsLoading ? (
                  <Skeleton className="h-[220px]" />
                ) : (
                  <SeriesChart
                    data={chartData}
                    xKey="from"
                    xFormatter={labelFor}
                    // Totals per period, so bars: a line between two months' totals
                    // draws a trend through days nobody drove, and the month still
                    // in progress read as a collapse rather than as a month so far.
                    series={[
                      {
                        key: "distance",
                        label: "Distance",
                        color: CHART_COLORS.blue,
                        unit: units.unitOfLength,
                        mark: "bar",
                      },
                      {
                        key: "energy",
                        label: "Charged",
                        color: CHART_COLORS.green,
                        unit: "kWh",
                        axis: "right",
                        mark: "bar",
                      },
                    ]}
                  />
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Cost and consumption</CardTitle>
              </CardHeader>
              <CardContent>
                {statsLoading ? (
                  <Skeleton className="h-[220px]" />
                ) : (
                  <SeriesChart
                    data={chartData}
                    xKey="from"
                    xFormatter={labelFor}
                    series={[
                      // The cost is a total and the consumption a rate: bars for
                      // the one, a line for the other.
                      { key: "cost", label: "Cost", color: CHART_COLORS.amber, unit: units.currency, mark: "bar" },
                      {
                        key: "consumption",
                        label: "Consumption",
                        color: CHART_COLORS.violet,
                        unit: `Wh/${units.unitOfLength}`,
                        axis: "right",
                      },
                    ]}
                  />
                )}
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Period</TableHead>
                    <TableHead className="text-right">Distance</TableHead>
                    <TableHead className="text-right">Time</TableHead>
                    <TableHead className="text-right">Drives</TableHead>
                    {/* The unit rides in the heading here rather than on every row, as
                        the neighbouring columns carry theirs — this table is read down
                        a column, and the figure changed scale when it changed unit. */}
                    <TableHead className="text-right">Consumption Wh/{units.unitOfLength}</TableHead>
                    <TableHead className="text-right">Charges</TableHead>
                    <TableHead className="text-right">Charged</TableHead>
                    <TableHead className="text-right">Cost</TableHead>
                    <TableHead className="text-right">Ø / kWh</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {statsLoading && <SkeletonRows columns={9} />}
                  {rows.map((bucket) => (
                    <TableRow key={bucket.key}>
                      <TableCell className="font-medium">{bucket.label}</TableCell>
                      <TableCell className="text-right tabular-nums">{u.distance(bucket.distanceKm, units)}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {u.duration(bucket.durationMin != null ? bucket.durationMin * 60 : null)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{bucket.driveCount}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {number(u.consumptionValue(bucket.consumptionKwhPer100km, units), 0)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{bucket.chargeCount}</TableCell>
                      <TableCell className="text-right tabular-nums">{u.energy(bucket.energyChargedKwh)}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {cost(bucket.costCents, units.currency)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {bucket.costPerKwhCents != null ? rate(bucket.costPerKwhCents, units.currency) : "–"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}

      <Card>
        <CardHeader>
          <div className="flex items-center gap-1.5">
            <CardTitle className="text-base">How the car gets driven</CardTitle>
            <InfoTip label="How the rates are worked out">
              {drivesData?.observedDays != null
                ? `Rates are per day across the ${Math.round(drivesData.observedDays)} days that hold drives, not across the whole window, so a short history is not averaged away.`
                : "A rate needs more than one day of driving before it means anything."}
            </InfoTip>
          </div>
          <CardDescription>Over {spanLabel}.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <StatTiles
            stats={[
              {
                label: "Typical drive",
                value: u.distance(drivesData?.medianDistanceKm, units, 1),
                hint: "median, not mean",
              },
              { label: "Ø per day", value: u.distance(drivesData?.distancePerDayKm, units, 1) },
              {
                label: "On track for",
                value: u.distance(drivesData?.projectedAnnualKm, units),
                hint: "a year at this rate",
              },
              { label: "Fastest", value: u.speed(drivesData?.maxSpeedKmh, units) },
            ]}
          />

          <div className="grid gap-6 lg:grid-cols-2">
            <div>
              <p className="mb-2 text-sm font-medium">Time at speed</p>
              {drivesLoading ? (
                <Skeleton className="h-[180px]" />
              ) : (
                <SeriesChart
                  kind="bar"
                  data={speedData}
                  xKey="from"
                  xFormatter={(value) => String(value)}
                  series={[{ key: "count", label: "Samples", color: CHART_COLORS.violet }]}
                  height={180}
                />
              )}
              <p className="text-xs text-muted-foreground">
                Position samples per {units.unitOfLength === "mi" ? "12 mph" : "20 km/h"} band, while moving.
              </p>
            </div>

            <div>
              <p className="mb-2 text-sm font-medium">Where drives end</p>
              {!drivesLoading && (drivesData?.topDestinations.length ?? 0) === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">No destinations recorded yet.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Destination</TableHead>
                      <TableHead className="text-right">Drives</TableHead>
                      <TableHead className="text-right">Distance</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {drivesLoading && <SkeletonRows columns={3} />}
                    {(!drivesLoading ? (drivesData?.topDestinations ?? []) : []).map((destination) => (
                      <TableRow key={placeText(destination.label, destination.region)}>
                        <TableCell
                          className="max-w-56 truncate font-medium"
                          title={placeText(destination.label, destination.region)}
                        >
                          <Place label={destination.label} region={destination.region} />
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{destination.count}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {u.distance(destination.distanceKm, units)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-1.5">
            <CardTitle className="text-base">What the electricity costs</CardTitle>
            <InfoTip label="Reading these figures">
              Cost per {units.unitOfLength === "mi" ? "100 miles" : "100 km"} is the figure that compares against a
              petrol car; the AC and DC rates are what say whether charging at home is paying off.
            </InfoTip>
          </div>
          <CardDescription>Over {spanLabel}.</CardDescription>
        </CardHeader>
        <CardContent>
          <StatTiles
            stats={[
              {
                label: `Per ${units.unitOfLength === "mi" ? "100 mi" : "100 km"}`,
                value:
                  chargingData?.costPer100kmCents != null
                    ? money(
                        units.unitOfLength === "mi"
                          ? chargingData.costPer100kmCents / 0.62137119223733
                          : chargingData.costPer100kmCents,
                        units.currency,
                      )
                    : "–",
                hint: "all charging, all driving",
              },
              {
                label: "AC per kWh",
                value: rate(perKwh(ac), units.currency),
                hint: ac?.count ? `${ac.count} sessions` : null,
              },
              {
                label: "DC per kWh",
                value: rate(perKwh(dc), units.currency),
                hint: dc?.count ? `${dc.count} sessions` : null,
              },
              {
                label: "At Superchargers",
                value: superchargerShare != null ? `${Math.round(superchargerShare * 100)} %` : "–",
                // A dash here can mean the car never reports which brand of charger it
                // is plugged into, which is not the same as never having Supercharged.
                hint:
                  superchargerShare != null
                    ? "of what was spent"
                    : chargingData?.superchargerCostCents == null
                      ? "this car does not report charger brand"
                      : "of what was spent",
              },
            ]}
          />
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">AC vs DC</CardTitle>
            <CardDescription>Where the energy came from, over {spanLabel}.</CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="divide-y text-sm">
              {[
                ["AC sessions", ac ? String(ac.count) : "–"],
                ["AC energy", u.energy(ac?.energyKwh)],
                ["AC cost", cost(ac?.costCents, units.currency)],
                ["DC sessions", dc ? String(dc.count) : "–"],
                ["DC energy", u.energy(dc?.energyKwh)],
                ["DC cost", cost(dc?.costCents, units.currency)],
              ].map(([label, value]) => (
                <div key={label} className="flex items-baseline justify-between gap-4 py-2">
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="font-medium tabular-nums">{value}</dd>
                </div>
              ))}
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Top charging locations</CardTitle>
            <CardDescription>By energy delivered, over {spanLabel}.</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {!chargingLoading && (chargingData?.topLocations.length ?? 0) === 0 ? (
              <p className="px-6 pb-6 text-sm text-muted-foreground">No charging sessions recorded yet.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Location</TableHead>
                    <TableHead className="text-right">Sessions</TableHead>
                    <TableHead className="text-right">Energy</TableHead>
                    <TableHead className="text-right">Cost</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {chargingLoading && <SkeletonRows columns={4} />}
                  {(!chargingLoading ? (chargingData?.topLocations ?? []) : []).map((location) => (
                    <TableRow key={location.label}>
                      <TableCell className="max-w-48 truncate font-medium">{location.label}</TableCell>
                      <TableCell className="text-right tabular-nums">{location.count}</TableCell>
                      <TableCell className="text-right tabular-nums">{u.energy(location.energyKwh)}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {cost(location.costCents, units.currency)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">When charging happens</CardTitle>
            <CardDescription>
              Sessions started over {spanLabel}, by day and hour in {units.timezone.replace("_", " ")}.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 overflow-x-auto">
            {/*
              Fixed layout with the label column pinned: under auto layout the hour
              headings that are deliberately blank collapse to nothing and the ones
              that are not take the slack, so the columns come out different widths
              and the grid stops being a grid.
            */}
            <table className="w-full min-w-[30rem] table-fixed border-separate border-spacing-[3px] text-xs">
              <colgroup>
                <col className="w-10" />
              </colgroup>
              <thead>
                <tr>
                  <th />
                  {Array.from({ length: 24 }, (_, hour) => (
                    <th key={hour} className="font-normal text-muted-foreground">
                      {/* Every third hour, or the labels collide on a phone. */}
                      {hour % 3 === 0 ? hour : ""}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {WEEKDAYS.map((name, index) => (
                  <tr key={name}>
                    <th scope="row" className="pr-1 text-right font-normal text-muted-foreground">
                      {name}
                    </th>
                    {Array.from({ length: 24 }, (_, hour) => {
                      const cell = heatByCell.get(`${index + 1}-${hour}`);
                      const count = cell?.count ?? 0;
                      return (
                        <td
                          key={hour}
                          className="p-0"
                          title={`${name} ${String(hour).padStart(2, "0")}:00 · ${count} ${
                            count === 1 ? "session" : "sessions"
                          }${cell?.energyKwh != null ? ` · ${u.energy(cell.energyKwh)}` : ""}`}
                        >
                          <div className="h-5 rounded-[4px]" style={{ background: heatColor(count, busiestCell) }} />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="flex items-center justify-end gap-1.5 text-xs text-muted-foreground" aria-hidden="true">
              Fewer
              {[0, 0.25, 0.5, 0.75, 1].map((share) => (
                <span key={share} className="size-3 rounded-[3px]" style={{ background: heatColor(share, 1) }} />
              ))}
              More
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center gap-1.5">
              <CardTitle className="text-base">The DC taper</CardTitle>
              <InfoTip label="About the taper">
                The shape of a fast charge with the noise of any single session averaged out.
              </InfoTip>
            </div>
            <CardDescription>
              Average power at each 10 % of the pack, across every DC session in {spanLabel}.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {chargingLoading ? (
              <Skeleton className="h-[200px]" />
            ) : (
              <SeriesChart
                data={curveData}
                xKey="band"
                xFormatter={(value) => `${value} %`}
                series={[{ key: "power", label: "Power", color: CHART_COLORS.amber, unit: "kW" }]}
                height={200}
              />
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Where the money goes</CardTitle>
          <CardDescription>
            The same places over {spanLabel}, ranked by spend rather than energy, which is rarely the same order.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {!chargingLoading && (chargingData?.topByCost.length ?? 0) === 0 ? (
            <p className="px-6 pb-6 text-sm text-muted-foreground">No priced sessions yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Location</TableHead>
                  <TableHead className="text-right">Sessions</TableHead>
                  <TableHead className="text-right">Energy</TableHead>
                  <TableHead className="text-right">Spent</TableHead>
                  <TableHead className="text-right">Per kWh</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {chargingLoading && <SkeletonRows columns={5} />}
                {(!chargingLoading ? (chargingData?.topByCost ?? []) : []).map((location) => (
                  <TableRow key={location.label}>
                    <TableCell className="max-w-48 truncate font-medium">{location.label}</TableCell>
                    <TableCell className="text-right tabular-nums">{location.count}</TableCell>
                    <TableCell className="text-right tabular-nums">{u.energy(location.energyKwh)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {cost(location.costCents, units.currency)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {location.costCents != null && location.energyKwh
                        ? rate(location.costCents / location.energyKwh, units.currency)
                        : "–"}
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
