import { Fragment, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { DrivesRouteDto, StateTimelineDto, TripDto, TripsDto } from "@shared/api-types";
import { api } from "@/lib/api";
import * as u from "@/lib/units";
import { cn } from "@/lib/utils";
import { dateOnly, dateTime, money, number, timeOnly, toDateInput } from "@/lib/format";
import { resolveWindow, type FilterState, type RangeContext } from "@/lib/filters";
import { PENDING_SETTINGS, useAppSettings, useCars } from "@/hooks/useAppSettings";
import { useRangeContext } from "@/hooks/useRangeContext";
import { useUrlFilters } from "@/hooks/useUrlFilters";
import { BatteryLevel } from "@/components/BatteryLevel";
import { DateRangeNav } from "@/components/DateRangeNav";
import { Button } from "@/components/ui/button";
import { Place, PlacePair } from "@/components/Place";
import { RouteMap } from "@/components/RouteMap";
import { StateBand } from "@/components/StateBand";
import { StatTiles } from "@/components/StatTiles";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/PageHeader";

/**
 * Journeys rather than drives.
 *
 * A road trip is one thing to a person and fourteen rows everywhere else in this
 * app. The grouping is [`core/trips`](../../src/core/trips.ts); this page is mostly
 * a composition of endpoints that already existed — the map is the drives list's
 * combined route pointed at a trip's window, and the band is the History page's
 * state timeline pointed at the same one. That is the whole reason a trip view is
 * cheap to have and was worth having.
 */

export function TripsPage() {
  const cars = useCars();
  const settings = useAppSettings();
  // Opens on a year — the span a question about road trips is asked over — but
  // offers all time too, the same as the lists do. Trips are grouped per request
  // rather than read from a table, so all time costs a scan of every drive, which
  // one car's history keeps affordable.
  const [filters, setFilters] = useUrlFilters("date", [], { defaultPreset: "1y" });
  const ctx = useRangeContext(settings.data?.timezone);

  const carId = filters.carId || (cars.data?.[0]?.id != null ? String(cars.data[0].id) : "");
  const range = resolveRange(filters, ctx);
  const query = `carId=${carId}&from=${range.from}${range.to != null ? `&to=${range.to}` : ""}`;

  const trips = useQuery({
    queryKey: ["trips", query],
    queryFn: () => api<TripsDto>(`/api/v1/trips?${query}`),
    enabled: Boolean(carId) && range.valid,
  });

  /*
    The frame — heading, range picker, tiles — is drawn before any request
    answers, so the page opens at its final shape and only the figures fill in.
    `data` stays undefined until settings are in as well as the trips, so the
    pending units can never label a real number with the wrong unit.
  */
  const units = settings.data ?? PENDING_SETTINGS;
  const data = settings.data != null ? trips.data : undefined;
  const loading = trips.isLoading || settings.data == null;

  const list = data?.trips ?? [];
  const selected = list.find((trip) => String(trip.startAt) === filters.trip) ?? null;
  // Both halves come from the server measured over drives that started in the window,
  // so one is a share of their sum. Summing the cards instead would put a journey that
  // began last month against a week of commuting.
  const onTrips = data?.tripDistanceKm ?? 0;
  const other = data?.otherDistanceKm ?? 0;
  const share = onTrips + other > 0 ? onTrips / (onTrips + other) : null;
  const spent = list.reduce((sum, trip) => sum + (trip.costCents ?? 0), 0);
  const longest = list.reduce<TripDto | null>(
    (best, trip) => (best == null || (trip.distanceKm ?? 0) > (best.distanceKm ?? 0) ? trip : best),
    null,
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Trips"
        description="Drives that belong to the same journey, grouped back together. Everyday driving is left out."
      />

      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        <DateRangeNav state={filters} onChange={setFilters} ctx={ctx} />

        {(cars.data?.length ?? 0) > 1 && (
          <div className="flex items-center gap-2 lg:ml-auto">
            <Label htmlFor="t-car" className="text-xs text-muted-foreground">
              Car
            </Label>
            <Select
              id="t-car"
              className="flex-1 lg:w-44 lg:flex-none"
              value={carId}
              onChange={(e) => setFilters({ carId: e.target.value, trip: "" })}
            >
              {cars.data?.map((car) => (
                <option key={car.id} value={car.id}>
                  {car.name ?? `VIN …${car.vin.slice(-6)}`}
                </option>
              ))}
            </Select>
          </div>
        )}
      </div>

      {/*
        Every tile reads "–" until there is an answer. A bold "0" above a skeleton, or
        left behind by a failed request, tells the reader with figures that they took
        no journeys — which is a different statement from not knowing yet.
      */}
      <StatTiles
        stats={[
          {
            label: "Trips",
            value: data ? String(list.length) : "–",
            hint: longest?.destinationLabel ? `longest was ${longest.destinationLabel}` : null,
          },
          { label: "Distance on trips", value: data ? u.distance(onTrips, units) : "–" },
          {
            label: "Share of the distance",
            value: share == null ? "–" : `${Math.round(share * 100)} %`,
            hint:
              data == null
                ? null
                : other > 0
                  ? `${u.distance(other, units)} was everyday driving`
                  : "everything in this window was on a trip",
          },
          {
            label: "Spent on the way",
            value: spent > 0 ? money(spent, units.currency) : "–",
            hint: spent > 0 ? "charging at stops in between" : null,
          },
        ]}
      />

      {/*
        A shared link names a trip the recipient's window may not contain, and a
        collapsed card with a stale parameter and no explanation is the worst version
        of that. Said out loud, with the way out beside it.
      */}
      {filters.trip !== "" && selected == null && data && (
        <Card>
          <CardContent className="flex flex-wrap items-center gap-3 pt-6 text-sm">
            <span className="text-muted-foreground">That journey is not in this window.</span>
            <Button variant="outline" size="sm" onClick={() => setFilters({ trip: "" })}>
              Clear it
            </Button>
          </CardContent>
        </Card>
      )}

      {loading ? (
        // Three collapsed trip cards' worth of shape, not one grey block: the
        // list arrives as cards, so the placeholder should already look like it.
        <div className="space-y-3">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-[88px] rounded-xl" />
          ))}
        </div>
      ) : !range.valid ? (
        <Card>
          <CardContent className="pt-6 text-sm text-muted-foreground">Pick a start and end date.</CardContent>
        </Card>
      ) : trips.isError ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Could not load the journeys</CardTitle>
            <CardDescription>
              The request failed rather than coming back empty, so this is not the same as having no trips.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="outline" size="sm" onClick={() => void trips.refetch()}>
              Try again
            </Button>
          </CardContent>
        </Card>
      ) : list.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">No trips in this window</CardTitle>
            <CardDescription>{criteria(data, units)}</CardDescription>
          </CardHeader>
          {/* A day or a week is almost never long enough to hold one. */}
          {narrowWindow(range) && (
            <CardContent>
              <Button variant="outline" size="sm" onClick={() => setFilters({ preset: "1y", from: "", to: "" })}>
                Look at the whole year
              </Button>
            </CardContent>
          )}
        </Card>
      ) : (
        <div className="space-y-3">
          <ul className="space-y-3">
            {list.map((trip) => (
              <li key={trip.startAt}>
                <TripCard
                  trip={trip}
                  units={units}
                  carId={carId}
                  expanded={trip === selected}
                  // Clicking the open one closes it, so the list can be got back to
                  // without reaching for the back button. Opening one also pins the
                  // window, so the link in the address bar carries the range the trip
                  // is actually in — without it a shared link resolves against
                  // whatever range the recipient last used.
                  onToggle={() =>
                    setFilters((current) =>
                      trip === selected
                        ? { trip: "" }
                        : { trip: String(trip.startAt), from: current.from || pinnedFrom(range, ctx) },
                    )
                  }
                />
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">{criteria(data, units)}</p>
        </div>
      )}
    </div>
  );
}

/**
 * What counted as a trip, in words. A list a heuristic produced has to be able to
 * say what it did, or a reader who disagrees with it has no way to tell whether the
 * journey is missing or was merely not considered one.
 */
function criteria(data: TripsDto | undefined, units: u.Units): string {
  if (!data) return "";
  const { minDrives, minDistanceKm, returnStopHours, longStopHours } = data.criteria;
  const hours = (n: number) => (n === 1 ? "an hour" : `${n} hours`);
  // The threshold goes through the same conversion as every other distance on the
  // page: stating the rule in kilometres to a reader who has chosen miles would be
  // quoting it in a unit that appears nowhere else here.
  return (
    `A trip is ${minDrives} or more drives covering at least ${u.distance(minDistanceKm, units)}, ` +
    `ending when the car has been back where it started for ${hours(returnStopHours)}, ` +
    `or parked anywhere for ${hours(longStopHours)}.`
  );
}

function TripCard({
  trip,
  units,
  carId,
  expanded,
  onToggle,
}: {
  trip: TripDto;
  units: NonNullable<ReturnType<typeof useAppSettings>["data"]>;
  carId: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const timezone = units.timezone;
  const days =
    dateOnly(trip.startAt, timezone) === dateOnly(trip.endAt, timezone)
      ? dateOnly(trip.startAt, timezone)
      : `${dateOnly(trip.startAt, timezone)} – ${dateOnly(trip.endAt, timezone)}`;

  const panelId = `trip-${trip.startAt}`;
  const headingId = `${panelId}-heading`;
  const figures: [string, string][] = [
    ["Distance", u.distance(trip.distanceKm, units)],
    ["Driving", u.duration(trip.drivingMin != null ? trip.drivingMin * 60 : null)],
    ["Charges", String(trip.chargeCount)],
    ["Cost", money(trip.costCents, units.currency)],
  ];

  return (
    <Card>
      {/*
        The title is the control and the figures sit beside it, rather than the whole
        header being one button with the figures inside.

        That was the first shape, and two things were wrong with it. A `button` takes
        phrasing content only, so a `dl` inside one is invalid; and ARIA treats a
        button's descendants as presentational, so the whole header collapsed into a
        single run-on accessible name — "Coast hotel 22 Jul · Home → Home Distance 373
        km Driving 3 h 56 min Charges 1 Cost 19.73, collapsed, button" — with no way to
        reach one figure. Splitting them keeps the figures readable as a list and makes
        each trip a heading the reader can navigate by. The button's ::after is
        stretched over the header row, so the whole block is still one click target
        without the figures ever entering the button's accessible name.
      */}
      <div
        className={cn(
          "relative flex flex-col gap-3 px-6 py-4 transition-colors hover:bg-muted/50 sm:flex-row sm:items-start",
          expanded ? "rounded-t-xl" : "rounded-xl",
        )}
      >
        <h2 id={headingId} className="min-w-0 flex-1 text-left">
          <button
            type="button"
            className="group w-full text-left after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:rounded-[inherit] focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-ring"
            aria-expanded={expanded}
            aria-controls={panelId}
            onClick={onToggle}
          >
            <span className="flex items-start gap-3">
              {expanded ? (
                <ChevronDown className="mt-1 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              ) : (
                <ChevronRight className="mt-1 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              )}
              <span className="min-w-0 flex-1">
                <span className="block font-medium">
                  <Place
                    label={trip.destinationLabel}
                    region={trip.destinationRegion}
                    fallback="Unnamed place"
                    inline
                  />
                  {trip.open && <span className="ml-2 text-xs font-normal text-muted-foreground">still under way</span>}
                </span>
                <span className="block truncate text-xs font-normal text-muted-foreground">
                  {days} ·{" "}
                  <PlacePair
                    startLabel={trip.startLabel}
                    startRegion={trip.startRegion}
                    endLabel={trip.endLabel}
                    endRegion={trip.endRegion}
                  />
                </span>
              </span>
            </span>
          </button>
        </h2>

        {/*
          Beside the title from sm up, wrapped underneath on a phone. The columns get
          fixed widths from sm on so the figures line up down the list — content-sized
          columns put every card's numbers somewhere slightly different.
        */}
        <dl className="flex shrink-0 flex-wrap gap-x-6 gap-y-1 pl-7 text-xs sm:grid sm:grid-cols-[repeat(4,5.5rem)] sm:gap-x-3 sm:pl-0 sm:text-right sm:text-sm">
          {figures.map(([label, value]) => (
            <div key={label} className="flex gap-1.5 sm:block">
              <dt className="text-muted-foreground sm:text-xs">{label}</dt>
              <dd className="font-medium tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
      </div>

      {expanded && <TripDetail trip={trip} units={units} carId={carId} panelId={panelId} headingId={headingId} />}
    </Card>
  );
}

/**
 * The trip itself. Nothing here has its own endpoint: the route is the drives
 * list's, the band is the History page's, and both are simply asked about the
 * trip's window instead of a picked one.
 */
function TripDetail({
  trip,
  units,
  carId,
  panelId,
  headingId,
}: {
  trip: TripDto;
  units: NonNullable<ReturnType<typeof useAppSettings>["data"]>;
  carId: string;
  panelId: string;
  headingId: string;
}) {
  const timezone = units.timezone;
  // The window is inclusive of the last drive's end, which a half-open `to` would
  // cut off — a drive that ends the trip has to be inside it.
  const window = `carId=${carId}&from=${trip.startAt}&to=${trip.endAt + 1}`;
  // A finished journey is immutable history, so browsing back to one costs nothing.
  // An open one is still growing.
  const staleTime = trip.open ? 60_000 : Infinity;

  const route = useQuery({
    queryKey: ["trip-route", window],
    queryFn: () => api<DrivesRouteDto>(`/api/v1/drives/route?${window}`),
    staleTime,
  });
  const band = useQuery({
    queryKey: ["trip-states", window],
    queryFn: () => api<StateTimelineDto>(`/api/v1/stats/states?${window}`),
    staleTime,
  });

  const figures: [string, string][] = [
    ["Drives", String(trip.driveCount)],
    ["Consumption", u.consumption(trip.consumptionKwhPer100km, units)],
    ["Used from the pack", u.energy(trip.energyKwh)],
    ["Put back in at the stops", u.energy(trip.chargedKwh)],
    ["Charge at the start", trip.startBatteryLevel != null ? `${trip.startBatteryLevel} %` : "–"],
    ["Lowest it got", trip.minBatteryLevel != null ? `${trip.minBatteryLevel} %` : "–"],
    ["Charge at the end", trip.endBatteryLevel != null ? `${trip.endBatteryLevel} %` : "–"],
  ];

  /*
    Elevation arrives per drive, as it closes: `Repo.enrichElevations` looks the
    terrain up against the coordinates the car reported, since no Tesla endpoint
    carries altitude. Imports do not enrich, so a trip stitched out of imported
    history has none, and neither does a drive whose lookup failed. It is omitted
    rather than shown empty, the way the drive detail omits its elevation chart:
    the Supercharger share taught this lesson a day earlier, at the cost of a tile
    that reported a confident nothing.
  */
  if (route.data?.minElevationM != null && route.data.maxElevationM != null) {
    figures.push(["Elevation", `${number(route.data.minElevationM, 0)} – ${number(route.data.maxElevationM, 0)} m`]);
  }

  return (
    <CardContent id={panelId} role="region" aria-labelledby={headingId} className="space-y-6 border-t pt-6">
      {trip.truncated && (
        <p className="text-xs text-muted-foreground">
          This journey runs past the fortnight either side of the window that trips are grouped over, so it may have
          more drives than are shown. Widen the range to see all of it.
        </p>
      )}
      {trip.open && (
        <p className="text-xs text-muted-foreground">
          Still under way, so everything below stops at the end of the last completed drive.
        </p>
      )}
      <div className="grid gap-6 lg:grid-cols-[3fr_2fr]">
        {route.isLoading ? (
          <Skeleton className="h-72" />
        ) : route.isError ? (
          // Not "no positions were logged": that is a claim about the data, made from
          // a failure to fetch it.
          <p className="py-8 text-center text-sm text-muted-foreground">Could not load the route for this trip.</p>
        ) : (route.data?.path.length ?? 0) === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">No positions were logged for this trip.</p>
        ) : (
          <RouteMap points={route.data!.path} className="h-72 w-full rounded-md border" />
        )}

        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 self-start text-sm">
          {figures.map(([label, value]) => (
            <div key={label} className="border-b pb-2">
              <dt className="text-xs text-muted-foreground">{label}</dt>
              <dd className="font-medium tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium">Where the time went</p>
        {band.isLoading ? (
          <Skeleton className="h-[92px]" />
        ) : band.data ? (
          <StateBand timeline={band.data} timezone={timezone} />
        ) : (
          <p className="text-sm text-muted-foreground">Could not load the states for this trip.</p>
        )}
      </div>

      <div className="space-y-2">
        {/*
          Not "on the way": the longest of these stops is the one the card is named
          after, so the row a reader cares about most is the destination itself.
        */}
        <p className="text-sm font-medium">Stop by stop</p>
        <Itinerary trip={trip} units={units} />
      </div>
    </CardContent>
  );
}

/**
 * The journey laid out as it went: place, drive, place, drive — a stops table
 * left the drives between them out entirely, so a trip read as a list of
 * parkings with no way to see what any hop took. The endpoints get filled dots,
 * because leaving and getting back are the trip's own edges rather than stops in
 * it; the last row of an open trip is the place the car is sitting now.
 */
function Itinerary({ trip, units }: { trip: TripDto; units: NonNullable<ReturnType<typeof useAppSettings>["data"]> }) {
  const timezone = units.timezone;
  // Times inside the itinerary carry a date only once it differs from the trip's
  // first day, the same rule the stops table used.
  const when = (at: number) =>
    dateOnly(at, timezone) === dateOnly(trip.startAt, timezone) ? timeOnly(at, timezone) : dateTime(at, timezone);

  return (
    <div className="relative">
      {/* One rail behind every dot, rather than per-row segments that have to meet. */}
      <span aria-hidden="true" className="absolute bottom-3 left-[5px] top-3 w-px bg-border" />
      <ol aria-label="The journey, stop by stop" className="text-sm">
        <Waypoint edge>
          <span className="font-medium">
            <Place label={trip.startLabel} region={trip.startRegion} fallback="Unnamed place" inline />
            <BatteryLevel level={trip.startBatteryLevel} className="ml-2" />
          </span>
          <span className="text-xs tabular-nums text-muted-foreground">left {when(trip.startAt)}</span>
        </Waypoint>

        {trip.legs.map((leg, index) => {
          const stop = trip.stops[index];
          return (
            <Fragment key={leg.startAt}>
              <li className="py-0.5 pl-6 text-xs text-muted-foreground">
                {u.duration(leg.durationMin != null ? leg.durationMin * 60 : null)} drive ·{" "}
                {u.distance(leg.distanceKm, units)}
              </li>
              {stop ? (
                <Waypoint>
                  <span className="font-medium">
                    <Place label={stop.label} region={stop.region} fallback="Unnamed place" inline />
                    <BatteryLevel level={stop.batteryLevel} className="ml-2" />
                  </span>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {when(stop.arrivedAt)} ·{" "}
                    {stop.stayedMin != null ? `stayed ${u.duration(stop.stayedMin * 60)}` : "still there"}
                    {stop.chargeCount > 0 && (
                      <span className="text-foreground">
                        {" "}
                        · charged {u.energy(stop.energyKwh)}
                        {stop.costCents != null && ` for ${money(stop.costCents, units.currency)}`}
                      </span>
                    )}
                  </span>
                </Waypoint>
              ) : (
                // No stop after the last leg means the journey is over: arriving
                // back is the end of the trip, not a stop inside it.
                <Waypoint edge>
                  <span className="font-medium">
                    <Place label={trip.endLabel} region={trip.endRegion} fallback="Unnamed place" inline />
                    <BatteryLevel level={trip.endBatteryLevel} className="ml-2" />
                  </span>
                  <span className="text-xs tabular-nums text-muted-foreground">arrived {when(trip.endAt)}</span>
                </Waypoint>
              )}
            </Fragment>
          );
        })}
      </ol>
    </div>
  );
}

/** A place on the rail. Filled for the trip's own edges, hollow for stops in it. */
function Waypoint({ edge = false, children }: { edge?: boolean; children: ReactNode }) {
  return (
    <li className="relative py-1 pl-6">
      <span
        aria-hidden="true"
        className={cn(
          "absolute left-0 top-[9px] size-3 rounded-full",
          edge ? "bg-primary" : "border-2 border-muted-foreground/40 bg-background",
        )}
      />
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">{children}</div>
    </li>
  );
}

/**
 * A window too short to plausibly hold a journey. The range is remembered across
 * pages, so arriving here straight from a list page showing one day means an empty
 * page and no hint that the window, not the history, is why.
 */
function narrowWindow(range: { from: number; to?: number; valid: boolean }): boolean {
  return range.valid && range.to != null && range.to - range.from < 28 * 86_400_000;
}

/**
 * The window's start as a date the filter state can carry, so opening a trip writes
 * the range into the URL alongside it.
 *
 * Without this the shared link is `?trip=1750000000000` and nothing else — the range
 * is left out whenever the user has not stepped off the current one, by design, so
 * that "this week" links stay evergreen. That is right for a range and wrong for a
 * trip: the recipient's own remembered range decides which window opens, and the
 * trip is very likely not in it.
 *
 * All time needs no pin: it is not this page's default, so `range=all` is already
 * in the URL, and every trip is inside it.
 */
function pinnedFrom(range: { from: number; to?: number; valid: boolean }, ctx: RangeContext): string {
  return range.valid && range.to != null ? toDateInput(range.from, ctx.timeZone) : "";
}

/**
 * As on History, a custom range is only half-entered until both dates are. All
 * time is the epoch onwards with the end left open: the API fills an absent `to`
 * with the present at request time, but fills an absent `from` with its own
 * default year, so the start has to be said outright.
 */
function resolveRange(filters: FilterState, ctx: RangeContext): { from: number; to?: number; valid: boolean } {
  if (filters.preset === "all") return { from: 0, valid: true };
  const window = resolveWindow(filters, ctx);
  const from = window.from ?? NaN;
  const to = window.to ?? NaN;
  return { from, to, valid: Number.isFinite(from) && Number.isFinite(to) && to > from };
}
