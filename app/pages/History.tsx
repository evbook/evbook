import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import type { ChargeLevelDto, StateTimelineDto, TimelineDto, TimelineEventKind } from "@shared/api-types";
import { api } from "@/lib/api";
import * as u from "@/lib/units";
import { dateOnly, dateTime, number, timeOnly } from "@/lib/format";
import { resolveWindow, type FilterState, type RangeContext } from "@/lib/filters";
import { PENDING_SETTINGS, useAppSettings, useCars } from "@/hooks/useAppSettings";
import { useRangeContext } from "@/hooks/useRangeContext";
import { useUrlFilters } from "@/hooks/useUrlFilters";
import { DateRangeNav } from "@/components/DateRangeNav";
import { EventLog, KIND_LABELS } from "@/components/EventLog";
import { CHART_COLORS, SeriesChart } from "@/components/SeriesChart";
import { StateBand } from "@/components/StateBand";
import { StatTiles } from "@/components/StatTiles";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { InfoTip } from "@/components/InfoTip";
import { PageHeader } from "@/components/PageHeader";

const DAY = 86_400_000;

/**
 * No all-time option here, for the reason below. Shared by the picker and the
 * filter state so a remembered "ALL" from a list page cannot land on this one.
 */
const ALLOW_ALL = false;

/** Every event kind, in the order the filter buttons offer them. */
const ALL_KINDS = Object.keys(KIND_LABELS) as TimelineEventKind[];

/** Events per request. The log appends, so this is a chunk size, not a page. */
const PAGE_SIZE = 50;

export function HistoryPage() {
  const cars = useCars();
  const settings = useAppSettings();
  // A band and a downsampled series are both proportions of a bounded window, so
  // unlike the list pages this one has no all-time option and opens on a week.
  const [filters, setFilters] = useUrlFilters("date", [], { defaultPreset: "1w", allowAll: ALLOW_ALL });
  const ctx = useRangeContext(settings.data?.timezone);

  const carId = filters.carId || (cars.data?.[0]?.id != null ? String(cars.data[0].id) : "");

  // Both queries share one window, so they can never disagree about it.
  const range = resolveRange(filters, ctx);
  const query = `carId=${carId}&from=${range.from}&to=${range.to}`;

  const timeline = useQuery({
    queryKey: ["state-timeline", query],
    queryFn: () => api<StateTimelineDto>(`/api/v1/stats/states?${query}`),
    enabled: Boolean(carId) && range.valid,
  });
  const level = useQuery({
    queryKey: ["charge-level", query],
    queryFn: () => api<ChargeLevelDto>(`/api/v1/stats/charge-level?${query}`),
    enabled: Boolean(carId) && range.valid,
  });

  // The log reads the same window, and additionally whatever the user has narrowed
  // it to. Kinds and search are part of the key, so changing either starts the
  // paging over rather than appending a differently-filtered page to what is there.
  const logQuery = [
    query,
    `limit=${PAGE_SIZE}`,
    filters.kinds.length > 0 ? `kinds=${filters.kinds.join(",")}` : "",
    filters.search ? `search=${encodeURIComponent(filters.search)}` : "",
  ]
    .filter(Boolean)
    .join("&");

  const log = useInfiniteQuery({
    queryKey: ["timeline", logQuery],
    queryFn: ({ pageParam }) =>
      api<TimelineDto>(`/api/v1/stats/timeline?${logQuery}${pageParam ? `&cursor=${pageParam}` : ""}`),
    initialPageParam: "",
    getNextPageParam: (last: TimelineDto) => last.nextCursor,
    enabled: Boolean(carId) && range.valid,
  });

  /*
    The frame — heading, range picker, tiles, card headers — is drawn before any
    request answers, so the page opens at its final shape and only the band, the
    chart and the log fill in. `pending` folds into each leaf's own loading
    state, so nothing is ever rendered against the fallback timezone.
  */
  const pending = settings.data == null;
  const units = settings.data ?? PENDING_SETTINGS;

  const multiDay = range.to - range.from > 2 * DAY;
  const shareOf = (state: string) => timeline.data?.totals.find((t) => t.state === state)?.share ?? null;
  const percent = (value: number | null) => (value == null ? "–" : `${Math.round(value * 100)} %`);

  const events = log.data?.pages.flatMap((page) => page.events) ?? [];
  // No kinds selected means all of them, so that the narrowed case is the only one
  // that shows up in the URL.
  const activeKinds = new Set<string>(filters.kinds.length > 0 ? filters.kinds : ALL_KINDS);

  const toggleKind = (kind: TimelineEventKind) =>
    setFilters((current) => {
      const active = new Set(current.kinds.length > 0 ? current.kinds : ALL_KINDS);
      if (active.has(kind)) active.delete(kind);
      else active.add(kind);
      const next = ALL_KINDS.filter((k) => active.has(k));
      // Turning the last kind off would ask for a log of nothing, so it does
      // nothing instead. Every kind on is stored as none, which is the same view.
      if (next.length === 0) return {};
      return { kinds: next.length === ALL_KINDS.length ? [] : next };
    });

  const levelData = (level.data?.points ?? []).map((p) => ({
    at: p.at,
    level: p.batteryLevel != null ? Math.round(p.batteryLevel) : null,
    usable: p.usableBatteryLevel != null ? Math.round(p.usableBatteryLevel) : null,
  }));

  return (
    <div className="space-y-6">
      <PageHeader
        title="History"
        description={<>What the car has been doing, and how charged it was, in {units.timezone.replace("_", " ")}.</>}
      />

      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        <DateRangeNav
          state={filters}
          onChange={setFilters}
          ctx={ctx}
          allowAll={ALLOW_ALL}
        />

        {(cars.data?.length ?? 0) > 1 && (
          <div className="flex items-center gap-2 lg:ml-auto">
            <Label htmlFor="h-car" className="text-xs text-muted-foreground">
              Car
            </Label>
            <Select
              id="h-car"
              className="flex-1 lg:w-44 lg:flex-none"
              value={carId}
              onChange={(e) => setFilters({ carId: e.target.value })}
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

      <StatTiles
        stats={[
          {
            label: "Now",
            value: timeline.data?.current ? u.stateLabel(timeline.data.current.state) : "–",
            hint: timeline.data?.current ? `for ${u.since(timeline.data.current.since)}` : null,
          },
          { label: "Asleep", value: percent(shareOf("asleep")) },
          { label: "Awake and idle", value: percent(shareOf("online")) },
          {
            label: "Ø charge level",
            value: level.data?.averageLevel != null ? `${number(level.data.averageLevel, 0)} %` : "–",
          },
        ]}
      />

      <Card>
        <CardHeader>
          <div className="flex items-center gap-1.5">
            <CardTitle className="text-base">Where the time went</CardTitle>
            <InfoTip label="Reading the band">
              Time nothing was logged for shows as a gap. The timeline below lists the same events one by one.
            </InfoTip>
          </div>
          <CardDescription>Drives, charges and firmware installs over the sleep states beneath them.</CardDescription>
        </CardHeader>
        <CardContent>
          {timeline.isLoading || pending ? (
            <Skeleton className="h-24" />
          ) : !range.valid ? (
            <p className="py-8 text-center text-sm text-muted-foreground">Pick a start and end date.</p>
          ) : timeline.data ? (
            <StateBand timeline={timeline.data} timezone={units.timezone} />
          ) : (
            <p className="py-8 text-center text-sm text-muted-foreground">Could not load the timeline.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-1.5">
            <CardTitle className="text-base">Charge level</CardTitle>
            <InfoTip label="Why it matters">
              Sitting at a high state of charge is the main thing you control about degradation.
            </InfoTip>
          </div>
          <CardDescription>
            {level.data ? `Averaged into ${u.duration(level.data.bucketMs / 1000)} buckets.` : "\u00a0"}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {level.isLoading || pending ? (
            // The chart's own height, so the figures below it do not move.
            <Skeleton className="h-[220px]" />
          ) : (
            <SeriesChart
              data={levelData}
              xKey="at"
              // Proportional, so a stretch the car logged nothing for stays a
              // gap rather than being squeezed out of the axis.
              xDomain={[range.from, range.to]}
              xFormatter={(value) => (multiDay ? dateOnly(value, units.timezone) : timeOnly(value, units.timezone))}
              series={[
                // Both filled: a state of charge is an amount of battery, and
                // the ink under each line is that amount. Usable is drawn
                // second, so its fade sits on top where the two nearly touch.
                { key: "level", label: "Charge level", color: CHART_COLORS.green, unit: "%", gradient: true },
                { key: "usable", label: "Usable", color: CHART_COLORS.teal, unit: "%", gradient: true },
              ]}
            />
          )}
          {/* Outside the loading branch: every value already reads "–" until it
              is known, so the rows can hold their place from the first paint. */}
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
            {[
              ["Lowest", level.data?.minLevel != null ? `${level.data.minLevel} %` : "–"],
              ["Highest", level.data?.maxLevel != null ? `${level.data.maxLevel} %` : "–"],
              [
                `At or above ${level.data?.highSocThreshold ?? 80} %`,
                level.data?.highSocShare != null ? `${Math.round(level.data.highSocShare * 100)} % of samples` : "–",
              ],
            ].map(([label, value]) => (
              <div key={label} className="flex items-baseline justify-between gap-4 border-b pb-2">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="font-medium tabular-nums">{value}</dd>
              </div>
            ))}
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Timeline</CardTitle>
          <CardDescription>Every event in the window, newest first. Drives and charges link to their own page.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
            <div className="flex flex-wrap gap-2" role="group" aria-label="Event kinds">
              {ALL_KINDS.map((kind) => (
                <Button
                  key={kind}
                  variant={activeKinds.has(kind) ? "default" : "outline"}
                  size="sm"
                  aria-pressed={activeKinds.has(kind)}
                  onClick={() => toggleKind(kind)}
                >
                  {KIND_LABELS[kind]}
                </Button>
              ))}
            </div>

            <div className="relative lg:ml-auto">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="w-full pl-8 lg:w-48"
                placeholder="Search places"
                aria-label="Search the timeline"
                value={filters.search}
                onChange={(e) => setFilters({ search: e.target.value })}
              />
            </div>
          </div>

          {log.isLoading || pending ? (
            <Skeleton className="h-64" />
          ) : !range.valid ? (
            <p className="py-8 text-center text-sm text-muted-foreground">Pick a start and end date.</p>
          ) : events.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {filters.search || filters.kinds.length > 0
                ? "Nothing in this window matches."
                : "Nothing logged in this window."}
            </p>
          ) : (
            <>
              <EventLog events={events} units={units} timezone={units.timezone} />
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">
                  {events.length} {events.length === 1 ? "event" : "events"}
                  {log.hasNextPage ? " so far" : ""}
                </span>
                {log.hasNextPage && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={log.isFetchingNextPage}
                    onClick={() => void log.fetchNextPage()}
                  >
                    {log.isFetchingNextPage ? "Loading…" : "Load more"}
                  </Button>
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {timeline.data && (
        <p className="text-xs text-muted-foreground">
          Window: {dateTime(timeline.data.from, units.timezone)} → {dateTime(timeline.data.to, units.timezone)}
        </p>
      )}
    </div>
  );
}

/**
 * The window, plus whether it is one the charts can be drawn against. A calendar
 * preset always resolves to both bounds; a custom range is only half-entered until
 * both dates are, and can be entered backwards.
 */
function resolveRange(filters: FilterState, ctx: RangeContext): { from: number; to: number; valid: boolean } {
  const window = resolveWindow(filters, ctx);
  const from = window.from ?? NaN;
  const to = window.to ?? NaN;
  return { from, to, valid: Number.isFinite(from) && Number.isFinite(to) && to > from };
}
