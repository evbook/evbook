import { useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import type { CarDto, CarSummaryDto, GlobalSettingsDto, StateTimelineDto } from "@shared/api-types";
import { api } from "@/lib/api";
import { liveRefreshInterval } from "@/lib/liveRefresh";
import { useCar } from "@/hooks/useCar";
import { useRangeContext } from "@/hooks/useRangeContext";
import { AtAGlance } from "@/components/AtAGlance";
import { CarCard } from "@/components/CarCard";
import { CarSwitcher } from "@/components/CarSwitcher";
import { InfoTip } from "@/components/InfoTip";
import { formatDate } from "@/lib/datetime";
import { StateBand } from "@/components/StateBand";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/** Poll only while the tab is visible so a background tab costs nothing. */
function useTabVisible() {
  const [visible, setVisible] = useState(() => !document.hidden);
  useEffect(() => {
    const onChange = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  return visible;
}

/** The cars this page offers; see the comment above `logged` below. */
const isLogged = (car: CarDto) => car.logged;

/** "Good morning", by the hour in the account's own time zone. */
function greeting(now: number, timezone: string) {
  const hour = Number(new Date(now).toLocaleString("en-US", { timeZone: timezone, hour: "numeric", hourCycle: "h23" }));
  if (hour < 5) return "Good night";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

export function OverviewPage() {
  const visible = useTabVisible();
  // The car on show, when there is more than one. The same pick as on every other
  // page, narrowed to the cars being logged.
  const { car: shown, choose } = useCar(isLogged);

  const cars = useQuery({ queryKey: ["cars"], queryFn: () => api<CarDto[]>("/api/v1/cars") });
  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: () => api<GlobalSettingsDto>("/api/v1/settings"),
  });
  const ctx = useRangeContext(settings.data?.timezone);
  const summaries = useQuery({
    queryKey: ["summaries"],
    queryFn: () => api<CarSummaryDto[]>("/api/v1/summaries"),
    refetchInterval: (query) => (visible ? liveRefreshInterval(query.state.data) : false),
  });

  if (cars.isLoading || settings.isLoading || summaries.isLoading) {
    /*
      The page's real shape, sketched: the greeting, the car's hero card with its
      map, the four history cards, and the last-day band — so nothing moves when
      the figures arrive.

      Summaries are part of the gate even though the cards can render without
      them: a card without its summary has no map, so letting it through here
      meant the sketched map collapsed to nothing for a beat and then shoved
      the page down when the summaries arrived.
    */
    return (
      <div className="space-y-6">
        <div className="space-y-2">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-8 w-56" />
        </div>
        <CarCardSkeleton />
        <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-36 rounded-xl sm:h-44" />
          ))}
        </div>
        <LastDayFrame>
          <Skeleton className="h-[92px]" />
        </LastDayFrame>
      </div>
    );
  }

  if (!cars.data?.length) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>No cars yet</CardTitle>
          <CardDescription>
            No vehicles were found on the connected account. If you just signed in, give it a moment and reload — or{" "}
            <Link to="/connect" className="underline">
              add a car
            </Link>{" "}
            from another account.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  /*
    Only the cars being logged. This page is entirely about the present — what the
    car is doing now, and whether it slept last night — and for a car with "Log
    this car" turned off there is no present to show: nothing polls it, so the card
    waits for a first summary that will never arrive and the band under it is empty
    for all 24 hours. The rest of the app still lists the car, because its history
    is worth reading whether or not anything is still being added to it.
  */
  const logged = cars.data.filter((car) => car.logged);

  if (logged.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Nothing is being logged</CardTitle>
          <CardDescription>
            {cars.data.length === 1 ? "This car has" : "These cars have"} logging switched off, so there is no live
            state to show. Turn it on under{" "}
            <Link to="/settings" className="underline">
              Settings
            </Link>
            . Whatever has already been recorded is still on the other pages.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  /*
    One car at a time, with a switch when there are two. Side by side, each car got
    half a page and the hero figures had to shrink to fit it; one at a time, the car
    you are looking at gets the whole page and the other is one tap away.
  */
  const car = shown ?? logged[0]!;
  const summary = (summaries.data ?? []).find((s) => s.carId === car.id);
  const timezone = settings.data!.timezone;
  const today = formatDate(ctx.now, "longDay", timezone);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <p className="text-sm text-muted-foreground">{today}</p>
          <p className="font-display text-[1.75rem] font-semibold leading-tight tracking-[-0.02em] sm:text-3xl">
            {greeting(ctx.now, timezone)}
          </p>
        </div>
        <CarSwitcher cars={logged} value={String(car.id)} onChange={choose} />
      </div>

      {summaries.isError && (
        <Card>
          <CardContent className="pt-6 text-sm text-destructive">Could not load live state. Retrying…</CardContent>
        </Card>
      )}

      <CarCard key={car.id} car={car} summary={summary} settings={settings.data!} />
      <AtAGlance carId={car.id} settings={settings.data!} now={ctx.now} visible={visible} />
      <LastDay car={car} timezone={timezone} now={ctx.now} visible={visible} />
    </div>
  );
}

/** A car card's shape before the cars are known: figures on the left, map on the right. */
function CarCardSkeleton() {
  return (
    <Card className="overflow-hidden shadow-raised">
      <div className="grid lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <Skeleton className="h-44 rounded-none sm:h-56 lg:order-2 lg:h-auto" />
        <div className="space-y-6 p-6 sm:p-8">
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-2">
              <Skeleton className="h-6 w-40" />
              <Skeleton className="h-4 w-44" />
            </div>
            <Skeleton className="h-6 w-20 rounded-full" />
          </div>
          <div className="flex items-end gap-10">
            <Skeleton className="h-16 w-36" />
            <Skeleton className="h-10 w-28" />
          </div>
          <Skeleton className="h-2.5 w-full rounded-full" />
          <Skeleton className="h-20 w-full rounded-xl" />
          <div className="space-y-3">
            {Array.from({ length: 2 }, (_, row) => (
              <div key={row} className="flex items-baseline justify-between">
                <Skeleton className="h-4 w-28" />
                <Skeleton className="h-4 w-20" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </Card>
  );
}

/**
 * The last-day card's chrome, shared by the loading sketch and the real thing —
 * the title is static, so it is on screen before the cars are even known and only
 * the band inside changes.
 */
function LastDayFrame({ children }: { children: ReactNode }) {
  return (
    <Card>
      <CardHeader className="pb-4">
        <div className="flex items-center gap-1.5">
          <CardTitle className="text-base">The last 24 hours</CardTitle>
          <InfoTip label="About this band">
            <p>Whether the car got to sleep. A long awake-and-idle stretch usually means polling holding it up.</p>
            <p>
              <Link to="/history" className="font-medium text-foreground underline underline-offset-2">
                History
              </Link>{" "}
              has the same band over any window.
            </p>
          </InfoTip>
        </div>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

/**
 * The last day, as one band. The card above says what the car is doing now, which
 * leaves the question you actually came with — did it sleep last night, or did
 * something hold it awake — one page away on History. This is the same endpoint and
 * the same component, over a fixed 24 hours.
 */
function LastDay({
  car,
  timezone,
  now,
  visible,
}: {
  car: CarDto;
  timezone: string;
  /**
   * The clock, from `useRangeContext`, which steps at the top of the minute rather
   * than being read during render. The window reaches the query key, and a key read
   * off `Date.now()` changes on every render and refetches on every one.
   */
  now: number;
  /** False in a background tab, where nothing here is being looked at. */
  visible: boolean;
}) {
  /*
    Quantized to the quarter hour. `now` steps every minute, and the window is in the
    query key, so following it to the minute meant sixty fetches an hour of a
    24-hour state timeline per car — for a tail one nine-hundredth of the band wide.
    `resolveWindow` coarsens its own windows for exactly this reason; this one is
    fixed rather than picked, so it does its own.
  */
  const step = 15 * 60_000;
  const to = Math.floor(now / step) * step;
  const from = to - 24 * 3_600_000;

  const states = useQuery({
    queryKey: ["overview-states", car.id, from, to],
    queryFn: () => api<StateTimelineDto>(`/api/v1/stats/states?carId=${car.id}&from=${from}&to=${to}`),
    // The card above it already stops polling in a hidden tab; so does this.
    enabled: visible,
    staleTime: step,
  });

  return (
    <LastDayFrame>
      {states.isLoading ? (
        <Skeleton className="h-[92px]" />
      ) : states.data ? (
        <StateBand timeline={states.data} timezone={timezone} />
      ) : (
        <p className="text-sm text-muted-foreground">Could not load the last day.</p>
      )}
    </LastDayFrame>
  );
}
