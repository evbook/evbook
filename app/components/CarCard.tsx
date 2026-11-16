import { useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  BatteryCharging,
  CarFront,
  Gauge,
  MapPin,
  Moon,
  Navigation,
  Route,
  Sun,
  Thermometer,
  Timer,
  Wrench,
  Zap,
} from "lucide-react";
import type { CarDto, CarSummaryDto, GlobalSettingsDto } from "@shared/api-types";
import { canDo, cardMode, figuresFor, type ReadingId } from "@shared/capabilities";
import { decodeVin } from "@shared/vin";
import { vehicleSubtitle } from "@shared/vehicleDetails";
import { trimMarketingName } from "@shared/trim";
import { api, ApiRequestError } from "@/lib/api";
import { releaseNotesUrl } from "@/lib/firmware";
import { boostLiveRefresh } from "@/lib/liveRefresh";
import { serviceFigure } from "@/lib/maintenance";
import { makeOf } from "@/lib/makes";
import * as u from "@/lib/units";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CarMap } from "@/components/CarMap";
import { Diagnostics, Row } from "@/components/Diagnostics";
import { Figure, Metric } from "@/components/Figure";
import { StatusChips } from "@/components/StatusChips";

function stateVariant(state: string): "default" | "secondary" | "success" | "outline" {
  switch (state) {
    case "driving":
      return "default";
    case "charging":
      return "success";
    case "asleep":
    case "offline":
      return "secondary";
    default:
      return "outline";
  }
}

/**
 * What the charger is delivering: "230 V · 16 A · 3 phases". Only the parts the
 * car reported, so a DC session — which has no phase count — says the two it does
 * know rather than an empty row or a made-up one.
 */
function supply(summary: CarSummaryDto): string | null {
  const parts = [
    summary.chargerVoltage != null ? `${summary.chargerVoltage} V` : null,
    summary.chargerCurrent != null ? `${summary.chargerCurrent} A` : null,
    summary.chargerPhases != null
      ? `${summary.chargerPhases} ${summary.chargerPhases === 1 ? "phase" : "phases"}`
      : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** A reading set as one of the card's figures. */
interface FigureSpec {
  label: string;
  icon: ReactNode;
  value: (summary: CarSummaryDto, settings: GlobalSettingsDto) => string;
}

/**
 * How each reading reads as a figure. Which three of them a card shows is not
 * decided here but by the provider's declaration and the car's mode
 * (`figuresFor` in `shared/capabilities.ts`).
 */
const FIGURES: Record<ReadingId, FigureSpec> = {
  speed: { label: "Speed", icon: <Gauge />, value: (s, units) => u.speed(s.speedKmh, units) },
  power: { label: "Power", icon: <Zap />, value: (s) => u.power(s.power) },
  outsideTemp: { label: "Outside", icon: <Thermometer />, value: (s, units) => u.temperature(s.outsideTemp, units) },
  insideTemp: { label: "Cabin", icon: <CarFront />, value: (s, units) => u.temperature(s.insideTemp, units) },
  odometer: { label: "Odometer", icon: <Route />, value: (s, units) => u.distance(s.odometerKm, units) },
  chargeLimit: {
    label: "Charge limit",
    icon: <BatteryCharging />,
    value: (s) => (s.chargeLimitSoc == null ? "–" : `${s.chargeLimitSoc} %`),
  },
  service: { label: "Next service", icon: <Wrench />, value: (s, units) => serviceFigure(s.maintenance, units) },
  chargerPower: { label: "Charger power", icon: <Zap />, value: (s) => u.power(s.chargerPower) },
  timeToFull: {
    label: "Time to full",
    icon: <Timer />,
    value: (s) => (s.timeToFullCharge ? u.hours(s.timeToFullCharge) : "–"),
  },
  energyAdded: { label: "Energy added", icon: <BatteryCharging />, value: (s) => u.energy(s.chargeEnergyAdded) },
};

export function CarCard({
  car,
  summary,
  settings,
}: {
  car: CarDto;
  summary: CarSummaryDto | undefined;
  settings: GlobalSettingsDto;
}) {
  const queryClient = useQueryClient();
  // A refusal reason goes stale as soon as the car does something else, so it is
  // kept against the state it was raised for and stops being shown once the car
  // moves on. Derived rather than reset from an effect: no second render pass, and
  // no separate piece of state to keep in step with this one.
  const [failure, setFailure] = useState<{ state: string | undefined; message: string } | null>(null);
  const state = summary?.state;
  const actionError = failure?.state === state ? (failure?.message ?? null) : null;

  const sleep = useMutation({
    mutationFn: async (action: "suspend" | "resume") => {
      setFailure(null);
      await api(`/api/v1/cars/${car.id}/logging/${action}`, { method: "PUT" });
    },
    onError: (error) => {
      setFailure({
        state,
        message: error instanceof ApiRequestError && error.message ? error.message : "Could not change logging state",
      });
    },
    onSuccess: () => {
      boostLiveRefresh();
      return queryClient.invalidateQueries({ queryKey: ["summaries"] });
    },
  });

  // The car takes tens of seconds to actually come online, so a successful
  // request is remembered against the state it was made in and shows as
  // "Waking…" until the poll moves the card to a different state — the same
  // derive-and-expire shape as `failure` above.
  const [wakeRequestedIn, setWakeRequestedIn] = useState<string | null>(null);
  const waking = wakeRequestedIn != null && wakeRequestedIn === state;
  const wake = useMutation({
    mutationFn: async () => {
      setFailure(null);
      await api(`/api/v1/cars/${car.id}/wake`, { method: "POST" });
    },
    onError: (error) => {
      setFailure({
        state,
        message: error instanceof ApiRequestError && error.message ? error.message : "Could not wake the car",
      });
    },
    onSuccess: () => {
      setWakeRequestedIn(state ?? null);
      boostLiveRefresh();
      void queryClient.invalidateQueries({ queryKey: ["summaries"] });
    },
  });

  const [navOpen, setNavOpen] = useState(false);
  const [destination, setDestination] = useState("");
  const [navError, setNavError] = useState<string | null>(null);
  const navigate = useMutation({
    mutationFn: async () => {
      await api(`/api/v1/cars/${car.id}/navigation`, {
        method: "POST",
        body: JSON.stringify({ destination }),
      });
    },
    onSuccess: () => {
      setNavOpen(false);
      setDestination("");
      setNavError(null);
    },
    onError: (error) => {
      setNavError(error instanceof ApiRequestError && error.message ? error.message : "Could not send the destination");
    },
  });

  const title = car.name ?? `VIN …${car.vin.slice(-6)}`;
  // The VIN carries the model year and names the Cybertruck and Semi, which
  // `cars.model` only has a letter for.
  const vin = decodeVin(car.vin);
  const trim = trimMarketingName({
    model: car.model ?? vin.model,
    trimBadging: car.trimBadging,
    modelYear: vin.modelYear,
    motorCount: vin.motorCount,
  });
  // What the provider reports beats the VIN where the VIN says nothing: a Volvo
  // reads "2022 XC40 AWD" like a Tesla's "2018 Model S 100D", without the make.
  // Only Tesla VINs are decoded, so any other make falls back to its name and the
  // model its API reported.
  const subtitle =
    vehicleSubtitle(car.model, car.details) ??
    (vin.manufacturer
      ? [vin.modelYear, vin.modelName ?? (car.model && `Model ${car.model}`), trim].filter(Boolean).join(" ")
      : [car.model && `${makeOf(car.provider)?.name ?? ""} ${car.model}`.trim()].filter(Boolean).join(" "));
  const canWake = canDo(car.provider, "wake");
  const canSleep = canDo(car.provider, "sleep");
  const canNavigate = canDo(car.provider, "navigate");

  if (!summary) {
    return (
      <Card>
        <CardContent className="pt-6">
          <h2 className="font-semibold">{title}</h2>
          <p className="mt-2 text-sm text-muted-foreground">Waiting for the first poll…</p>
        </CardContent>
      </Card>
    );
  }

  const preferredRangeKm =
    settings.preferredRange === "ideal" ? summary.idealBatteryRangeKm : summary.ratedBatteryRangeKm;
  const isCharging = summary.state === "charging";
  const isDriving = summary.state === "driving";
  const isSuspended = summary.state === "falling_asleep";
  const isAsleep = summary.state === "asleep" || summary.state === "offline";
  const hasLocation = summary.latitude != null && summary.longitude != null;
  // The usable portion is what actually drives the car, so it is the figure.
  const level = summary.usableBatteryLevel ?? summary.batteryLevel;
  const live = isCharging || isDriving;

  /*
    The three readings that matter for what the car is doing right now, set as
    figures; everything else stays a row underneath. Which three is the
    provider's declaration and the mode's priorities (`figuresFor`), never the
    values of the moment: a reading the car is not sending right now reads "–"
    and keeps its place.
  */
  const figures = figuresFor(car.provider, cardMode(summary.state));
  const metrics = figures.map((id) => ({
    key: id,
    label: FIGURES[id].label,
    icon: FIGURES[id].icon,
    value: FIGURES[id].value(summary, settings),
  }));
  const inMetrics = new Set<ReadingId>(figures);

  return (
    <Card className="relative overflow-hidden shadow-raised" style={{ backgroundImage: "var(--hero-wash)" }}>
      <div className={cn("grid", hasLocation && "lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]")}>
        {/*
          The map is the card's backdrop rather than a strip across its top: on a
          wide screen it fills the right half and fades into the card along its
          inner edge, on a phone it sits above and fades into the figures below.
          It is a picture of where the car is, not a tool, so it gives up its hard
          edges to the card it is part of.
        */}
        {hasLocation && (
          <div className="relative h-44 sm:h-56 lg:order-2 lg:h-auto">
            <CarMap
              latitude={summary.latitude!}
              longitude={summary.longitude!}
              heading={summary.heading}
              details={{ speedKmh: summary.speedKmh, units: settings }}
              className="evb-map-fade-bottom lg:evb-map-fade-left absolute inset-0"
            />
          </div>
        )}

        <div className={cn("relative space-y-6 p-6 sm:p-8", hasLocation && "-mt-10 sm:-mt-14 lg:mt-0")}>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="font-display text-xl font-semibold leading-tight tracking-tight sm:text-2xl">{title}</h2>
              {subtitle && <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>}
            </div>
            {/*
              A status region, not a decorative badge: this is the one thing on the
              page that changes under the reader, so a screen reader should announce
              it when it does. It also makes the state addressable — the last-24-hours
              band names the same states in its legend, and "Driving" as bare text now
              means two different things on this page.
            */}
            {/*
              The car's name is deliberately *not* repeated in here. With two cars an
              announcement of just "Charging" does not say which one changed, and the
              obvious fix — an `sr-only` name inside the badge — puts the car's name in
              the page a second time, where every `getByText` and every reader scanning
              the DOM finds two of it. The heading is one line above; that is the
              context, and it is not worth duplicating for the two-car case.
            */}
            <Badge role="status" variant={stateVariant(summary.state)} className="shrink-0 shadow-card">
              <span aria-hidden="true" className={cn("size-1.5 rounded-full bg-current", live && "evb-live")} />
              {u.stateLabel(summary.state)}
            </Badge>
          </div>

          <StatusChips summary={summary} units={settings} />

          {/* The pack: charge as the figure, range beside it, the bar under both. */}
          {level != null && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-end gap-x-10 gap-y-3">
                <div>
                  <p className="text-xs font-medium text-muted-foreground">Battery</p>
                  <p className="mt-2 text-6xl font-semibold sm:text-7xl">
                    <span className="evb-figure">
                      {level}
                      <span className="evb-unit">%</span>
                    </span>
                  </p>
                </div>
                {preferredRangeKm != null && (
                  <div className="pb-1">
                    <p className="text-xs font-medium text-muted-foreground">Range</p>
                    <p className="mt-2 text-3xl font-semibold sm:text-4xl">
                      <Figure text={u.distance(preferredRangeKm, settings)} />
                    </p>
                  </div>
                )}
              </div>
              <PackBar level={level} limit={summary.chargeLimitSoc} charging={isCharging} />
              <div className="flex flex-wrap justify-between gap-x-4 gap-y-1 text-xs text-muted-foreground tabular-nums">
                <span>
                  {[
                    summary.usableBatteryLevel != null &&
                    summary.batteryLevel != null &&
                    summary.usableBatteryLevel !== summary.batteryLevel
                      ? `${summary.batteryLevel}% total`
                      : null,
                    summary.chargeLimitSoc != null && !inMetrics.has("chargeLimit")
                      ? `Charge limit ${summary.chargeLimitSoc}%`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
                {summary.estBatteryRangeKm != null && (
                  <span>Estimated {u.distance(summary.estBatteryRangeKm, settings)}</span>
                )}
              </div>
            </div>
          )}

          {/* As many columns as the provider has figures: a car that reports only
              its odometer gets one figure, not two empty cells beside it. */}
          {metrics.length > 0 && (
            <dl
              className={cn(
                "grid divide-x overflow-hidden rounded-xl border bg-background/60 dark:bg-background/40",
                FIGURE_COLUMNS[metrics.length],
              )}
            >
              {metrics.map(({ key, ...metric }) => (
                <Metric key={key} {...metric} />
              ))}
            </dl>
          )}

          <dl className="divide-y">
            <Row
              label="Status"
              value={
                summary.since
                  ? `${u.stateLabel(summary.state)} for ${u.since(summary.since)}`
                  : u.stateLabel(summary.state)
              }
            />
            {/*
              The supply itself, which the power figure alone does not give you:
              11 kW could be three phases at 16 A or one at 48, and only one of
              those is worth complaining to an electrician about.
            */}
            {isCharging && <Row label="Supply" value={supply(summary)} />}
            {!inMetrics.has("outsideTemp") && (
              <Row label="Outside temperature" value={u.temperature(summary.outsideTemp, settings)} />
            )}
            {!inMetrics.has("insideTemp") && (
              <Row label="Inside temperature" value={u.temperature(summary.insideTemp, settings)} />
            )}
            {/* Only while the climate is running: a set point nothing is working
                towards is a stale number, not a reading. */}
            {summary.isClimateOn && (
              <Row label="Climate set to" value={u.temperature(summary.driverTempSetting, settings)} />
            )}
            {!inMetrics.has("odometer") && <Row label="Odometer" value={u.distance(summary.odometerKm, settings)} />}
            {/*
              The version links to its release notes on notateslaapp, which is where
              you go anyway once you notice the car is on something new. No link when
              the string does not parse as a release — see `releaseNotesUrl`.
            */}
            <Row label="Firmware" value={summary.version} href={releaseNotesUrl(summary.version)} />
          </dl>

          <div className="space-y-4 border-t pt-4">
            <Diagnostics summary={summary} settings={settings} />

            {summary.sleepBlocker && (
              <p className="text-xs text-muted-foreground">Cannot sleep: {summary.sleepBlocker.toLowerCase()}</p>
            )}
            {actionError && <p className="text-xs text-destructive">{actionError}</p>}

            <div className="flex flex-wrap items-center gap-2">
              {/*
                Only what the provider declares: a car EVBook only reads (a Volvo)
                gets no wake, sleep or destination. Wake and sleep share a slot —
                the one thing to do with a sleeping car is the opposite of what the
                sleep button offers.
              */}
              {isAsleep ? (
                canWake && (
                  <Button
                    variant="outline"
                    size="sm"
                    className={ACTION}
                    disabled={wake.isPending || waking}
                    onClick={() => wake.mutate()}
                  >
                    <Sun /> {waking ? "Waking…" : "Wake"}
                  </Button>
                )
              ) : !canSleep ? null : isSuspended ? (
                <Button
                  variant="outline"
                  size="sm"
                  className={ACTION}
                  disabled={sleep.isPending}
                  onClick={() => sleep.mutate("resume")}
                >
                  <BatteryCharging /> Cancel sleep attempt
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  className={ACTION}
                  // Only meaningful when the car is awake and idle.
                  disabled={sleep.isPending || summary.state !== "online"}
                  title={
                    summary.state === "online"
                      ? undefined
                      : `Not available while ${u.stateLabel(summary.state).toLowerCase()}`
                  }
                  onClick={() => sleep.mutate("suspend")}
                >
                  <Moon /> Try to sleep
                </Button>
              )}
              {canNavigate && (
                <Button
                  variant="outline"
                  size="sm"
                  className={ACTION}
                  // An asleep car refuses the destination rather than being woken for
                  // it — the wake next door is a decision, not a side effect.
                  disabled={isAsleep}
                  title={isAsleep ? `Not available while ${u.stateLabel(summary.state).toLowerCase()}` : undefined}
                  onClick={() => {
                    setNavError(null);
                    setNavOpen(true);
                  }}
                >
                  <Navigation /> Navigate
                </Button>
              )}
              {hasLocation && (
                <a
                  className={cn(buttonVariants({ variant: "ghost", size: "sm" }), ACTION, "text-muted-foreground")}
                  href={`https://www.openstreetmap.org/?mlat=${summary.latitude}&mlon=${summary.longitude}#map=16/${summary.latitude}/${summary.longitude}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <MapPin /> Open map
                </a>
              )}
            </div>
          </div>
        </div>
      </div>

      <Dialog open={navOpen} onClose={() => setNavOpen(false)}>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (destination.trim()) navigate.mutate();
          }}
        >
          <div>
            <h3 className="font-semibold">Send destination</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Appears in the car's navigation, like sharing an address from your phone.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`nav-destination-${car.id}`}>Destination</Label>
            <Input
              id={`nav-destination-${car.id}`}
              placeholder="Address, place, or lat,lon"
              value={destination}
              onChange={(e) => setDestination(e.target.value)}
              autoFocus
            />
          </div>
          {navError && <p className="text-xs text-destructive">{navError}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setNavOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={navigate.isPending || !destination.trim()}>
              {navigate.isPending ? "Sending…" : "Send to car"}
            </Button>
          </div>
        </form>
      </Dialog>
    </Card>
  );
}

/** Spelled out so Tailwind sees each class; indexed by the number of figures. */
const FIGURE_COLUMNS: Record<number, string> = { 1: "grid-cols-1", 2: "grid-cols-2", 3: "grid-cols-3" };

/** The car's own actions: pills, one size, so the row reads as one control. */
const ACTION = "h-9 rounded-full px-4";

/**
 * The pack as a bar: filled to the usable charge in the brand's gradient — the
 * charge one while energy is going in, with light moving along it — and a tick at
 * the charge limit, which is where a charge will stop and so where the bar is
 * headed.
 */
function PackBar({ level, limit, charging }: { level: number; limit: number | null; charging: boolean }) {
  const width = Math.max(2, Math.min(100, level));
  return (
    <div className="relative h-2.5 rounded-full bg-foreground/[0.07] dark:bg-foreground/10">
      <div
        className={cn(
          "h-full rounded-full transition-[width] duration-700 ease-out",
          charging ? "evb-gradient-charge evb-charging" : level < 15 ? "bg-warning" : "evb-gradient-brand",
        )}
        style={{ width: `${width}%` }}
      />
      {limit != null && limit < 100 && (
        <div
          aria-hidden="true"
          className="absolute -inset-y-1 w-0.5 -translate-x-1/2 rounded-full bg-foreground/35"
          style={{ left: `${limit}%` }}
        />
      )}
    </div>
  );
}
