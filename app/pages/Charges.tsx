import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import type { ChargeListDto, ChargeMapDto } from "@shared/api-types";
import { api } from "@/lib/api";
import * as u from "@/lib/units";
import { cost, eventDuration, eventTimes, money, rate, weekdayDate } from "@/lib/format";
import { ReconstructedBadge } from "@/components/Reconstructed";
import { hasActiveFilters, toQuery, type RangeParamMap } from "@/lib/filters";
import { PENDING_SETTINGS, useAppSettings } from "@/hooks/useAppSettings";
import { useCar } from "@/hooks/useCar";
import { useRangeContext } from "@/hooks/useRangeContext";
import { useUrlFilters } from "@/hooks/useUrlFilters";
import { ChargeMap } from "@/components/ChargeMap";
import { FilterPanel, RECORDED_CHOICE, SortHeader, type RangeConfig } from "@/components/FilterPanel";
import { CarSwitcher } from "@/components/CarSwitcher";
import { SkeletonRows } from "@/components/TableSkeleton";
import { Place, placeText } from "@/components/Place";
import { perItem, StatTiles } from "@/components/StatTiles";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
const RANGE_KEYS = ["energy", "duration", "cost"];

/**
 * The line under a total: what it comes to per session, and — where the sum has a
 * figure for only some of them — how many it was really divided by. "Ø 8.40 € over
 * 12 of 213 sessions" is the whole point of saying it: a cost divided by every
 * session would read as though charging were nearly free, when what is true is
 * that most of it was never priced.
 */
function perSession(value: string, of: number, count: number): string {
  return of === count ? `Ø ${value} per session` : `Ø ${value} over ${of} of ${count} sessions`;
}

/** Cost is entered in currency units; the API stores integer cents. */
const RANGE_PARAMS: RangeParamMap = {
  energy: { min: "minEnergyKwh", max: "maxEnergyKwh" },
  duration: { min: "minDurationMin", max: "maxDurationMin" },
  cost: { min: "minCostCents", max: "maxCostCents", scale: 100 },
};

export function ChargesPage() {
  const [filters, setFilters] = useUrlFilters("date", RANGE_KEYS);
  const settings = useAppSettings();
  const { carId, cars, choose, query: carsQuery } = useCar();
  const range = useRangeContext(settings.data?.timezone);

  const query = `carId=${carId}&${toQuery(filters, RANGE_PARAMS, PAGE_SIZE, range)}`;
  const charges = useQuery({
    queryKey: ["charges", query],
    queryFn: () => api<ChargeListDto>(`/api/v1/charges?${query}`),
    placeholderData: (previous) => previous,
    enabled: carId !== "",
  });

  // The map covers everything the filters match, not the page on screen, so
  // sorting or paging the table must not refetch it.
  const mapQuery = new URLSearchParams(query);
  for (const key of ["sort", "dir", "limit", "offset"]) mapQuery.delete(key);
  const mapKey = mapQuery.toString();
  const places = useQuery({
    queryKey: ["charges", "map", mapKey],
    queryFn: () => api<ChargeMapDto>(`/api/v1/charges/map?${mapKey}`),
    placeholderData: (previous) => previous,
    enabled: carId !== "",
  });

  /*
    The frame — heading, filter row, tiles, table header — is drawn before any
    request answers, so the page opens at its final shape and only the figures
    fill in. Until settings are in, everything below is a placeholder, so the
    pending units can never label a real number with the wrong unit.
  */
  const ready = settings.data != null && carsQuery.data != null;
  const units = settings.data ?? PENDING_SETTINGS;

  const totals = ready ? charges.data?.totals : undefined;
  const bounds = ready ? charges.data?.bounds : undefined;
  const rows = (ready && charges.data?.charges) || [];
  const loadingRows = !ready || charges.isLoading;
  const points = (ready && places.data?.points) || [];
  const loadingMap = !ready || places.isLoading;
  const energyTotal =
    totals?.energyAddedKwh != null || totals?.energyUsedKwh != null
      ? Math.max(totals?.energyAddedKwh ?? 0, totals?.energyUsedKwh ?? 0)
      : null;

  // Each sum over the sessions that actually carry that figure, not over all of
  // them — the counts come from the API for exactly this.
  const avgEnergyKwh = perItem(totals?.energyAddedKwh, totals?.energyAddedCount);
  const avgCostCents = perItem(totals?.costCents, totals?.costCount);

  const rangeConfigs: RangeConfig[] = bounds
    ? [
        {
          key: "energy",
          label: "Energy",
          bound: bounds.energyKwh,
          format: (value) => `${Math.round(value)} kWh`,
        },
        {
          key: "duration",
          label: "Duration",
          bound: bounds.durationMin,
          format: (value) => u.duration(value * 60),
        },
        {
          key: "cost",
          label: "Cost",
          // Bounds arrive in cents; the slider works in currency units.
          bound: { min: bounds.costCents.min / 100, max: bounds.costCents.max / 100 },
          format: (value) => money(value * 100, units.currency),
        },
      ]
    : [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Charges"
        description="Every charging session, what it added and what it cost."
        actions={<CarSwitcher cars={cars} value={carId} onChange={choose} />}
      />

      <FilterPanel
        state={filters}
        onChange={setFilters}
        ranges={rangeConfigs}
        ctx={range}
        defaultSort="date"
        locations={[{ key: "location", label: "Location" }]}
        choices={[
          {
            key: "currentType",
            label: "Current",
            options: [
              { value: "", label: "AC and DC" },
              { value: "ac", label: "AC only" },
              { value: "dc", label: "DC only" },
            ],
          },
          RECORDED_CHOICE,
        ]}
      />

      {/* Each total carries what it comes to per session underneath. The rate tile
          has no such line: its face is already an average, and both figures it is
          made of — the cost and the energy — are the two tiles to its left. */}
      <StatTiles
        stats={[
          { label: "Sessions", value: totals ? totals.count.toLocaleString() : "–" },
          {
            label: "Energy added",
            value: u.energy(totals?.energyAddedKwh),
            hint:
              totals && avgEnergyKwh != null
                ? perSession(u.energy(avgEnergyKwh), totals.energyAddedCount, totals.count)
                : null,
          },
          {
            label: "Cost",
            value: cost(totals?.costCents, units.currency, totals?.costMaxCents),
            hint:
              totals && avgCostCents != null
                ? perSession(money(avgCostCents, units.currency), totals.costCount, totals.count)
                : null,
          },
          {
            label: "Ø cost / kWh",
            value:
              totals?.costCents != null && energyTotal ? rate(totals.costCents / energyTotal, units.currency) : "–",
          },
        ]}
      />

      {/* Drawn while the map is still loading too — almost every log has charges,
          so holding the card back would drop the table by its whole height once
          the points arrived. It only disappears for a log with nothing to map. */}
      {(loadingMap || points.length > 0) && (
        <Card className="overflow-hidden">
          <CardHeader>
            <CardTitle className="text-base">Where you charge</CardTitle>
            <CardDescription>
              {places.data && points.length > 0
                ? [
                    `${points.length} ${points.length === 1 ? "place" : "places"}`,
                    `${points.reduce((sum, p) => sum + p.count, 0)} sessions mapped`,
                    places.data.unlocated > 0 ? `${places.data.unlocated} without a location` : null,
                    places.data.truncated ? "busiest places only" : null,
                  ]
                    .filter(Boolean)
                    .join(" · ") + ". "
                : ""}
              Each bubble shows how many times the car charged there; hover or tap one for the energy and cost.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {loadingMap ? (
              <Skeleton className="h-80 w-full rounded-t-none" />
            ) : (
              <ChargeMap points={points} timezone={units.timezone} currency={units.currency} className="h-80 w-full" />
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-0">
          {!loadingRows && rows.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">
              {hasActiveFilters(filters)
                ? "No charging sessions match these filters."
                : "No charging sessions logged yet."}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>
                    <SortHeader label="Start" column="date" state={filters} onChange={setFilters} />
                  </TableHead>
                  <TableHead>Location</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead className="text-right">
                    <SortHeader label="Added" column="energy" state={filters} onChange={setFilters} align="right" />
                  </TableHead>
                  <TableHead className="text-right">
                    <SortHeader label="SoC" column="battery" state={filters} onChange={setFilters} align="right" />
                  </TableHead>
                  <TableHead className="text-right">
                    <SortHeader
                      label="Duration"
                      column="duration"
                      state={filters}
                      onChange={setFilters}
                      align="right"
                    />
                  </TableHead>
                  <TableHead className="text-right">
                    <SortHeader label="Max power" column="power" state={filters} onChange={setFilters} align="right" />
                  </TableHead>
                  <TableHead className="text-right">
                    <SortHeader label="Cost" column="cost" state={filters} onChange={setFilters} align="right" />
                  </TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {loadingRows && <SkeletonRows columns={9} />}
                {rows.map((charge) => (
                  <TableRowLink key={charge.id} to={`/charges/${charge.id}`}>
                    {/* The day leads and the times sit under it, so a column of rows
                        reads down the dates rather than through a run of timestamps. */}
                    <TableCell>
                      <Link to={`/charges/${charge.id}`} viewTransition className="font-medium hover:underline">
                        {weekdayDate(charge.startAt, units.timezone)}
                      </Link>
                      {charge.reconstructed && (
                        <>
                          {" "}
                          <ReconstructedBadge kind="charge" />
                        </>
                      )}
                      <span className="block text-xs text-muted-foreground tabular-nums">
                        {eventTimes(charge, units.timezone)}
                      </span>
                    </TableCell>
                    <TableCell className="max-w-56 truncate" title={placeText(charge.label, charge.region)}>
                      <Place label={charge.label} region={charge.region} />
                    </TableCell>
                    <TableCell>
                      {/* Nobody saw the charger: AC or DC is unknown, not AC. */}
                      {charge.reconstructed ? (
                        <span className="text-muted-foreground">–</span>
                      ) : (
                        <Badge variant={charge.currentType === "dc" ? "default" : "secondary"}>
                          {charge.currentType.toUpperCase()}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{u.energy(charge.energyAddedKwh)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {charge.startBatteryLevel != null && charge.endBatteryLevel != null
                        ? `${charge.startBatteryLevel} → ${charge.endBatteryLevel}%`
                        : "–"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{eventDuration(charge, u.duration)}</TableCell>
                    <TableCell className="text-right tabular-nums">{u.power(charge.maxPowerKw)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {cost(charge.costCents, units.currency, charge.costMaxCents)}
                      {charge.costPerKwhCents != null && (
                        <span className="block text-xs text-muted-foreground">
                          {rate(charge.costPerKwhCents, units.currency)}/kWh
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="w-0 text-right">
                      <RowChevron to={`/charges/${charge.id}`} />
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
