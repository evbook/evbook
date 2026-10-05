import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { BatteryFull, CalendarDays, ChevronRight, PlugZap, Route } from "lucide-react";
import { Link } from "react-router";
import type { BatteryHealthDto, ChargeListDto, DriveListDto, GlobalSettingsDto, PeriodStatsDto } from "@shared/api-types";
import { api } from "@/lib/api";
import { dayAndTime, money, toDateInput } from "@/lib/format";
import * as u from "@/lib/units";
import { cn } from "@/lib/utils";
import { Figure } from "@/components/Figure";
import { Place, PlacePair } from "@/components/Place";
import { Skeleton } from "@/components/ui/skeleton";

/*
  How often the panel looks again while the page is open. These are history, not
  live state — a drive only lands once it has ended — so a minute is plenty, and
  a background tab does not look at all.
*/
const REFRESH = 60_000;

/** The month key the stats buckets use ("2026-09"), `back` months before `at`. */
function monthKey(at: number, timezone: string, back = 0): string {
  const [year, month] = toDateInput(at, timezone).split("-").map(Number) as [number, number];
  const index = year * 12 + (month - 1) - back;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

/**
 * The car's recent history in four cards under the live one: the last drive, the
 * last charge, the month so far, and the pack. The live card says what the car is
 * doing; these say what it has been doing, so the page you land on answers the
 * next question too, and each card is the way into the page that says more.
 */
export function AtAGlance({
  carId,
  settings,
  now,
  visible,
}: {
  carId: number;
  settings: GlobalSettingsDto;
  now: number;
  visible: boolean;
}) {
  const poll = { refetchInterval: visible ? REFRESH : false, staleTime: REFRESH } as const;
  const latest = `carId=${carId}&sort=date&dir=desc&limit=1&offset=0`;

  const drive = useQuery({
    queryKey: ["overview-last-drive", latest],
    queryFn: () => api<DriveListDto>(`/api/v1/drives?${latest}`),
    ...poll,
  });
  const charge = useQuery({
    queryKey: ["overview-last-charge", latest],
    queryFn: () => api<ChargeListDto>(`/api/v1/charges?${latest}`),
    ...poll,
  });
  /*
    The month so far, and the one before it for scale. From ten weeks back rather
    than the endpoint's default two years: two buckets are wanted, and the window
    is quantized to the hour so the key does not change under the minute clock.
  */
  const from = Math.floor((now - 70 * 86_400_000) / 3_600_000) * 3_600_000;
  const months = useQuery({
    queryKey: ["overview-months", carId, from],
    queryFn: () => api<PeriodStatsDto>(`/api/v1/stats?period=month&carId=${carId}&from=${from}`),
    ...poll,
  });
  const health = useQuery({
    queryKey: ["overview-health", carId],
    queryFn: () => api<BatteryHealthDto>(`/api/v1/stats/battery-health?carId=${carId}`),
    staleTime: 60 * 60_000,
  });

  const lastDrive = drive.data?.drives[0];
  const lastCharge = charge.data?.charges[0];
  const thisMonth = months.data?.buckets.find((b) => b.key === monthKey(now, settings.timezone));
  const lastMonth = months.data?.buckets.find((b) => b.key === monthKey(now, settings.timezone, 1));
  const monthName = new Date(now).toLocaleDateString(undefined, { timeZone: settings.timezone, month: "long" });

  return (
    <section aria-label="Recent history" className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
      <GlanceCard
        to={lastDrive ? `/drives/${lastDrive.id}` : "/drives"}
        icon={<Route />}
        title="Last drive"
        when={lastDrive ? dayAndTime(lastDrive.startAt, settings.timezone, now) : undefined}
        loading={drive.isLoading}
        empty={!lastDrive ? "No drives logged yet." : undefined}
        figure={lastDrive ? u.distance(lastDrive.distanceKm, settings, 1) : ""}
        caption={
          lastDrive && (
            <PlacePair
              startLabel={lastDrive.startLabel}
              startRegion={lastDrive.startRegion}
              endLabel={lastDrive.endLabel}
              endRegion={lastDrive.endRegion}
            />
          )
        }
        meta={
          lastDrive
            ? [
                lastDrive.durationMin != null ? u.duration(lastDrive.durationMin * 60) : null,
                lastDrive.consumptionKwhPer100km != null ? u.consumption(lastDrive.consumptionKwhPer100km, settings) : null,
              ]
            : []
        }
      />
      <GlanceCard
        to={lastCharge ? `/charges/${lastCharge.id}` : "/charges"}
        icon={<PlugZap />}
        tone="charge"
        title="Last charge"
        when={lastCharge ? dayAndTime(lastCharge.startAt, settings.timezone, now) : undefined}
        loading={charge.isLoading}
        empty={!lastCharge ? "No charging sessions yet." : undefined}
        figure={lastCharge ? u.energy(lastCharge.energyAddedKwh) : ""}
        caption={lastCharge && <Place label={lastCharge.label} region={lastCharge.region} inline />}
        meta={
          lastCharge
            ? [
                lastCharge.currentType.toUpperCase(),
                lastCharge.startBatteryLevel != null && lastCharge.endBatteryLevel != null
                  ? `${lastCharge.startBatteryLevel} → ${lastCharge.endBatteryLevel}%`
                  : null,
                lastCharge.costCents != null ? money(lastCharge.costCents, settings.currency) : null,
              ]
            : []
        }
      />
      <GlanceCard
        to="/stats"
        icon={<CalendarDays />}
        title={monthName}
        when="So far"
        loading={months.isLoading}
        figure={u.distance(thisMonth?.distanceKm ?? 0, settings)}
        caption={
          <>
            {thisMonth?.driveCount ?? 0} {thisMonth?.driveCount === 1 ? "drive" : "drives"} ·{" "}
            {u.energy(thisMonth?.energyChargedKwh ?? 0)} charged
            {thisMonth?.costCents != null && ` · ${money(thisMonth.costCents, settings.currency)}`}
          </>
        }
        meta={[lastMonth?.distanceKm != null ? `Last month ${u.distance(lastMonth.distanceKm, settings)}` : null]}
      />
      <GlanceCard
        to="/health"
        icon={<BatteryFull />}
        title="Battery"
        loading={health.isLoading}
        empty={health.data?.currentCapacityKwh == null ? "Not enough charging yet to measure the pack." : undefined}
        figure={u.energy(health.data?.currentCapacityKwh)}
        caption="Usable capacity"
        meta={[
          health.data?.degradationFromNewPercent != null
            ? `${health.data.degradationFromNewPercent.toFixed(1)}% below new`
            : health.data?.degradationPercent != null
              ? `${health.data.degradationPercent.toFixed(1)}% since first logged`
              : null,
          health.data?.currentRangeAt100Km != null
            ? `${u.distance(health.data.currentRangeAt100Km, settings)} at 100%`
            : null,
        ]}
      />
    </section>
  );
}

/**
 * One card of the panel: what it is and when, one figure, a line of context, and
 * a line of detail. The whole card is the link — there is nothing else on it to
 * click — so it lifts on hover the way a link should say it is one.
 */
function GlanceCard({
  to,
  icon,
  tone = "brand",
  title,
  when,
  loading,
  empty,
  figure,
  caption,
  meta,
}: {
  to: string;
  icon: ReactNode;
  tone?: "brand" | "charge";
  title: string;
  when?: string;
  loading: boolean;
  empty?: string;
  figure: string;
  caption?: ReactNode;
  meta: (string | null)[];
}) {
  const details = meta.filter(Boolean);
  return (
    <Link
      to={to}
      viewTransition
      className={cn(
        "group relative flex min-h-36 min-w-0 flex-col rounded-xl border bg-card p-4 text-card-foreground shadow-card sm:min-h-44 sm:p-5",
        "transition-[box-shadow,transform,border-color] duration-200 hover:-translate-y-0.5 hover:border-input hover:shadow-raised",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
      )}
    >
      <div className="flex items-center gap-2.5">
        <span
          aria-hidden="true"
          className={cn(
            "grid size-7 place-items-center rounded-lg [&_svg]:size-3.5",
            tone === "charge" ? "bg-success/12 text-success" : "bg-brand/10 text-brand",
          )}
        >
          {icon}
        </span>
        <span className="truncate text-sm font-medium">{title}</span>
        {/* Beside the title where there is room for it; on a phone's half-width
            card it leads the detail line instead. */}
        {when && <span className="ml-auto hidden text-xs text-muted-foreground tabular-nums sm:inline">{when}</span>}
        <ChevronRight
          aria-hidden="true"
          className={cn(
            "ml-auto size-4 shrink-0 text-muted-foreground/60 transition-transform group-hover:translate-x-0.5",
            when && "sm:ml-0",
          )}
        />
      </div>
      {loading ? (
        <div className="mt-auto space-y-2.5 pt-5 sm:pt-6">
          <Skeleton className="h-8 w-28" />
          <Skeleton className="h-4 w-full" />
        </div>
      ) : empty ? (
        <p className="mt-auto pt-5 text-sm text-muted-foreground sm:pt-6">{empty}</p>
      ) : (
        <div className="evb-rise mt-auto min-w-0 pt-5 sm:pt-6">
          <p className="text-2xl font-semibold sm:text-3xl">
            <Figure text={figure} />
          </p>
          {caption && <p className="mt-2 truncate text-sm text-foreground/80">{caption}</p>}
          {(details.length > 0 || when) && (
            <p className="mt-1 truncate text-xs text-muted-foreground tabular-nums">
              {when && <span className="sm:hidden">{when}{details.length > 0 && " · "}</span>}
              {details.join(" · ")}
            </p>
          )}
        </div>
      )}
    </Link>
  );
}
