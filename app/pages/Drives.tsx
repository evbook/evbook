import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { ChevronDown, Map as MapIcon } from "lucide-react";
import type { DriveListDto, DrivesRouteDto } from "@shared/api-types";
import { api } from "@/lib/api";
import * as u from "@/lib/units";
import { cn } from "@/lib/utils";
import { cost, dateTime, eventDuration, eventTimeEnds, number, weekdayDate } from "@/lib/format";
import { ReconstructedBadge } from "@/components/Reconstructed";
import { hasActiveFilters, toQuery, type RangeParamMap } from "@/lib/filters";
import { PENDING_SETTINGS, useAppSettings, useCars } from "@/hooks/useAppSettings";
import { useRangeContext } from "@/hooks/useRangeContext";
import { useUrlFilters } from "@/hooks/useUrlFilters";
import { FilterPanel, SortHeader, type RangeConfig } from "@/components/FilterPanel";
import { SkeletonRows } from "@/components/TableSkeleton";
import { Place, placeText } from "@/components/Place";
import { RouteMap } from "@/components/RouteMap";
import { TripIcon } from "@/components/TripIcon";
import { perItem, StatTiles } from "@/components/StatTiles";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  RowChevron,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableRowLink,
} from "@/components/ui/table";
import { PageHeader } from "@/components/PageHeader";

const PAGE_SIZE = 50;
const RANGE_KEYS = ["distance", "duration", "consumption"];
const MILES_PER_KM = 0.62137119223733;

/**
 * The distance slider works in the user's units, but the API stores kilometres,
 * so miles are scaled back on the way out.
 */
function rangeParams(unitOfLength: "km" | "mi"): RangeParamMap {
  return {
    distance: {
      min: "minDistanceKm",
      max: "maxDistanceKm",
      scale: unitOfLength === "mi" ? 1 / MILES_PER_KM : 1,
    },
    duration: { min: "minDurationMin", max: "maxDurationMin" },
    consumption: {
      min: "minConsumption",
      max: "maxConsumption",
      // The handles read in Wh per unit of distance; the API takes kWh per 100 km.
      scale: (unitOfLength === "mi" ? MILES_PER_KM : 1) / 10,
    },
  };
}

/**
 * The energy under the consumption figure. Two decimals below a tenth of a kWh,
 * because the rows whose ratio is withheld for being too short are exactly the
 * rows a single decimal rounds to "0.0 kWh" — which reads as a fault rather than
 * as the fraction of a kWh a shunt up the driveway really costs.
 */
function energyCell(kwh: number | null): string {
  if (kwh != null && kwh !== 0 && Math.abs(kwh) < 0.1) return `${number(kwh, 2)} kWh`;
  return u.energy(kwh);
}

/**
 * A mean duration, in seconds, for the same line. Durations are stored as whole
 * minutes, so a mean carried down to the second reads as precision the figures
 * under it do not have — 38 min 56 s out of 37 drives measured to the minute. It
 * is rounded to the minute, except under half a one, where the seconds are the
 * whole figure rather than a tail on it.
 */
function meanDurationSec(minutes: number | null): number | null {
  if (minutes == null) return null;
  return minutes >= 0.5 ? Math.round(minutes) * 60 : Math.round(minutes * 60);
}

/** A row's times with the trip glyph between them; a reconstructed drive's one line as it is. */
function DriveTimes({ drive, timezone }: { drive: Parameters<typeof eventTimeEnds>[0]; timezone: string }) {
  const times = eventTimeEnds(drive, timezone);
  if (typeof times === "string") return times;
  return (
    <>
      {times[0]} <TripIcon /> {times[1]}
    </>
  );
}

export function DrivesPage() {
  const [filters, setFilters] = useUrlFilters("date", RANGE_KEYS);
  const [showRoute, setShowRoute] = useState(false);
  const settings = useAppSettings();
  const cars = useCars();
  const range = useRangeContext(settings.data?.timezone);

  const query = toQuery(filters, rangeParams(settings.data?.unitOfLength ?? "km"), PAGE_SIZE, range);

  const drives = useQuery({
    queryKey: ["drives", query],
    queryFn: () => api<DriveListDto>(`/api/v1/drives?${query}`),
    placeholderData: (previous) => previous,
  });

  // Only fetched once the combined map is opened.
  const route = useQuery({
    queryKey: ["drives-route", query],
    queryFn: () => api<DrivesRouteDto>(`/api/v1/drives/route?${query}`),
    enabled: showRoute,
  });

  /*
    The frame — heading, filter row, tiles, table header — is drawn before any
    request answers, so the page opens at its final shape and only the figures
    fill in. Until settings are in, everything below is a placeholder, so the
    pending units can never label a real number with the wrong unit.
  */
  const ready = settings.data != null && cars.data != null;
  const units = settings.data ?? PENDING_SETTINGS;

  const totals = ready ? drives.data?.totals : undefined;
  const bounds = ready ? drives.data?.bounds : undefined;
  const rows = (ready && drives.data?.drives) || [];
  const multipleCars = (cars.data?.length ?? 0) > 1;
  const loadingRows = !ready || drives.isLoading;

  /*
    Divided by every drive in the selection, including any whose own figure is
    missing: the first tile says how many drives these are, and an average that
    quietly counted fewer would not multiply back into the total above it. A closed
    drive has a distance and a duration, so there is nothing to exclude anyway —
    unlike a charge session's cost, which is usually never priced at all.
  */
  const avgDistanceKm = perItem(totals?.distanceKm, totals?.count);
  const avgDurationMin = perItem(totals?.durationMin, totals?.count);
  const avgEnergyKwh = perItem(totals?.energyKwh, totals?.count);

  // Sliders work in the user's units, so km bounds are converted for display.
  const toDisplay = (km: number) => (units.unitOfLength === "mi" ? km * MILES_PER_KM : km);
  const rangeConfigs: RangeConfig[] = bounds
    ? [
        {
          key: "distance",
          label: "Distance",
          bound: { min: toDisplay(bounds.distanceKm.min), max: toDisplay(bounds.distanceKm.max) },
          format: (value) => `${Math.round(value)} ${units.unitOfLength}`,
        },
        {
          key: "duration",
          label: "Duration",
          bound: bounds.durationMin,
          format: (value) => u.duration(value * 60),
        },
        {
          key: "consumption",
          label: "Consumption",
          // Converted like the distance handles above, not just relabelled: the API's
          // bounds are per 100 km whichever unit the reader has chosen.
          bound: {
            min: Math.max(0, u.consumptionValue(bounds.consumption.min, units) ?? 0),
            max: u.consumptionValue(bounds.consumption.max, units) ?? 0,
          },
          format: (value) => `${Math.round(value)} Wh/${units.unitOfLength}`,
        },
      ]
    : [];

  return (
    <div className="space-y-6">
      <PageHeader title="Drives" description="Every drive the car has logged." />

      <FilterPanel
        cars={cars.data ?? []}
        state={filters}
        onChange={setFilters}
        ranges={rangeConfigs}
        ctx={range}
        defaultSort="date"
        locations={[
          { key: "startLocation", label: "From" },
          { key: "endLocation", label: "To" },
        ]}
      />

      {/* Each total carries what it comes to per drive underneath. Consumption is
          the exception: the figure on its face is already an average — the energy
          of the whole selection over its distance — so the line under it holds the
          energy, as a total and per drive, rather than repeating the ratio. */}
      <StatTiles
        stats={[
          { label: "Drives", value: totals ? totals.count.toLocaleString() : "–" },
          {
            label: "Distance",
            value: u.distance(totals?.distanceKm, units),
            hint: avgDistanceKm != null ? `Ø ${u.distance(avgDistanceKm, units, 1)} per drive` : null,
          },
          {
            label: "Time driven",
            value: u.duration(totals?.durationMin != null ? totals.durationMin * 60 : null),
            hint: avgDurationMin != null ? `Ø ${u.duration(meanDurationSec(avgDurationMin))} per drive` : null,
          },
          {
            label: "Consumption",
            value: totals?.consumptionKwhPer100km != null ? u.consumption(totals.consumptionKwhPer100km, units) : "–",
            hint:
              totals?.energyKwh != null
                ? [
                    avgEnergyKwh != null ? `Ø ${energyCell(avgEnergyKwh)} per drive` : null,
                    `${number(totals.energyKwh, 0)} kWh total`,
                  ]
                    .filter(Boolean)
                    .join(", ")
                : null,
          },
        ]}
      />

      {/* The combined route and charging summary for whatever is filtered —
          this is what used to be a separate trip report page. Drawn while the
          list is still loading too: almost every log has drives, so holding the
          card back would push the table down a row once the count arrived. */}
      {(loadingRows || (totals?.count ?? 0) > 0) && (
        <Card>
          <button
            onClick={() => setShowRoute((s) => !s)}
            className="flex w-full items-center justify-between gap-3 p-4 text-left"
            aria-expanded={showRoute}
          >
            <span className="inline-flex items-center gap-2 text-sm font-medium">
              <MapIcon className="size-4" />
              {hasActiveFilters(filters)
                ? "Route and charging for this selection"
                : "Route and charging for all drives"}
            </span>
            <ChevronDown className={cn("size-4 transition-transform", showRoute && "rotate-180")} />
          </button>
          {showRoute && (
            <CardContent className="space-y-4 pt-0">
              {route.isLoading ? (
                <Skeleton className="h-72" />
              ) : (route.data?.path.length ?? 0) === 0 ? (
                <p className="text-sm text-muted-foreground">No positions recorded for these drives.</p>
              ) : (
                <>
                  <RouteMap points={route.data!.path} className="h-72 w-full rounded-md border" />
                  <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                    {[
                      ["Charging sessions", String(route.data!.charging.count)],
                      ["Energy charged", u.energy(route.data!.charging.energyKwh)],
                      [
                        "Time charging",
                        u.duration(
                          route.data!.charging.durationMin != null ? route.data!.charging.durationMin * 60 : null,
                        ),
                      ],
                      [
                        "Charging cost",
                        route.data!.charging.costCents != null
                          ? cost(route.data!.charging.costCents, units.currency)
                          : "–",
                      ],
                    ].map(([label, value]) => (
                      <div key={label}>
                        <dt className="text-xs text-muted-foreground">{label}</dt>
                        <dd className="font-medium tabular-nums">{value}</dd>
                      </div>
                    ))}
                  </dl>
                  <p className="text-xs text-muted-foreground">
                    Charging counted between the first and last drive shown
                    {route.data!.fromAt != null && route.data!.toAt != null
                      ? ` (${dateTime(route.data!.fromAt, units.timezone)} – ${dateTime(route.data!.toAt, units.timezone)})`
                      : ""}
                    .
                  </p>
                </>
              )}
            </CardContent>
          )}
        </Card>
      )}

      <Card>
        <CardContent className="p-0">
          {!loadingRows && rows.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">
              {hasActiveFilters(filters)
                ? "No drives match these filters."
                : "No drives logged yet. They appear here once the car has been driven and parked."}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>
                    <SortHeader label="Start" column="date" state={filters} onChange={setFilters} />
                  </TableHead>
                  {multipleCars && <TableHead>Car</TableHead>}
                  <TableHead>From</TableHead>
                  <TableHead>To</TableHead>
                  {/* Two headings in one column, stacked as the cell below them is, so
                      both stay sortable while costing the width of the longer word. */}
                  <TableHead className="text-right">
                    <SortHeader
                      label="Distance"
                      column="distance"
                      state={filters}
                      onChange={setFilters}
                      align="right"
                    />
                    <span className="block font-normal">
                      <SortHeader
                        label="Duration"
                        column="duration"
                        state={filters}
                        onChange={setFilters}
                        align="right"
                      />
                    </span>
                  </TableHead>
                  <TableHead className="text-right">
                    <SortHeader label="SoC" column="battery" state={filters} onChange={setFilters} align="right" />
                  </TableHead>
                  {/* Stacked like Distance/Duration above, which also puts the figure
                      and what it was derived from in one column. Energy could already
                      be sorted on; nothing in the UI had asked for it until now. */}
                  <TableHead className="text-right">
                    <SortHeader
                      label="Consumption"
                      column="consumption"
                      state={filters}
                      onChange={setFilters}
                      align="right"
                    />
                    <span className="block font-normal">
                      <SortHeader label="Energy" column="energy" state={filters} onChange={setFilters} align="right" />
                    </span>
                  </TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {loadingRows && <SkeletonRows columns={multipleCars ? 8 : 7} />}
                {rows.map((drive) => (
                  <TableRowLink key={drive.id} to={`/drives/${drive.id}`}>
                    {/* The day leads and the times sit under it, so a column of rows
                        reads down the dates rather than through a run of timestamps. */}
                    <TableCell>
                      <Link to={`/drives/${drive.id}`} viewTransition className="font-medium hover:underline">
                        {weekdayDate(drive.startAt, units.timezone)}
                      </Link>
                      {drive.reconstructed && (
                        <>
                          {" "}
                          <ReconstructedBadge kind="drive" />
                        </>
                      )}
                      <span className="block text-xs text-muted-foreground tabular-nums">
                        <DriveTimes drive={drive} timezone={units.timezone} />
                      </span>
                    </TableCell>
                    {multipleCars && (
                      <TableCell className="text-muted-foreground">
                        {cars.data?.find((c) => c.id === drive.carId)?.name ?? drive.carId}
                      </TableCell>
                    )}
                    {/* The town goes on a second line, so what has to fit here is the
                        wider of two halves rather than their sum — a one-line "Aristofani,
                        Ypsonas Municipality" outgrew every width worth giving a column.
                        Either half alone can still outrun the cell, hence the title. */}
                    <TableCell className="max-w-56 truncate" title={placeText(drive.startLabel, drive.startRegion)}>
                      <Place label={drive.startLabel} region={drive.startRegion} />
                    </TableCell>
                    <TableCell className="max-w-56 truncate" title={placeText(drive.endLabel, drive.endRegion)}>
                      <Place label={drive.endLabel} region={drive.endRegion} />
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {u.distance(drive.distanceKm, units, 1)}
                      <span className="block text-xs text-muted-foreground">{eventDuration(drive, u.duration)}</span>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {drive.startBatteryLevel != null && drive.endBatteryLevel != null
                        ? `${drive.startBatteryLevel} → ${drive.endBatteryLevel}%`
                        : "–"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {u.consumption(drive.consumptionKwhPer100km, units)}
                      <span className="block text-xs text-muted-foreground">{energyCell(drive.energyUsedKwh)}</span>
                    </TableCell>
                    <TableCell className="w-0 text-right">
                      <RowChevron to={`/drives/${drive.id}`} />
                    </TableCell>
                  </TableRowLink>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {(filters.page > 0 || rows.length === PAGE_SIZE) && (
        <div className="flex items-center justify-between">
          <Button
            variant="outline"
            size="sm"
            disabled={filters.page === 0}
            onClick={() => setFilters((current) => ({ page: current.page - 1 }))}
          >
            Previous
          </Button>
          <span className="text-sm text-muted-foreground">
            {totals
              ? `${filters.page * PAGE_SIZE + 1}–${filters.page * PAGE_SIZE + rows.length} of ${totals.count}`
              : ""}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={rows.length < PAGE_SIZE}
            onClick={() => setFilters((current) => ({ page: current.page + 1 }))}
          >
            Next
          </Button>
        </div>
      )}
    </div>
  );
}
