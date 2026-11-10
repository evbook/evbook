import { useState } from "react";
import { ChevronDown, Gauge } from "lucide-react";
import type { CarSummaryDto, GlobalSettingsDto } from "@shared/api-types";
import * as u from "@/lib/units";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

/**
 * One label/value row of a detail table. Rows with no value are dropped.
 *
 * `href` turns the value into a link out — somewhere off the app that says more
 * about this particular reading. It is optional and off by default: most values
 * here are numbers with nothing to read about them.
 */
export function Row({ label, value, href }: { label: string; value: string | null; href?: string }) {
  if (value === null || value === "–") return null;
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium tabular-nums">
        {href ? (
          <a href={href} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
            {value}
          </a>
        ) : (
          value
        )}
      </dd>
    </div>
  );
}

function onOff(value: boolean | null): string | null {
  return value == null ? null : value ? "On" : "Off";
}

function yesNo(value: boolean | null): string | null {
  return value == null ? null : value ? "Yes" : "No";
}

const CORNER_LABELS = ["Front left", "Front right", "Rear left", "Rear right"] as const;

/**
 * "All closed", or the open corners by name. Null — dropping the row — only
 * when the car reported none of the four, so a car that does report them says
 * "All closed" out loud rather than silently omitting the row it usually has.
 */
function openings(corners: (boolean | null)[]): string | null {
  if (corners.every((c) => c == null)) return null;
  const open = CORNER_LABELS.filter((_, i) => corners[i] === true);
  return open.length === 0 ? "All closed" : `${open.join(", ")} open`;
}

/**
 * The four tyre pressures on one row, each corner flagged when the car has
 * raised its soft pressure warning for it. A custom row rather than `Row`
 * because a corner's warning colours that corner, not the whole value.
 */
function TyreRow({ summary, settings }: { summary: CarSummaryDto; settings: GlobalSettingsDto }) {
  const corners = [
    { label: "FL", bar: summary.tpmsPressureFl, warn: summary.tpmsSoftWarningFl === true },
    { label: "FR", bar: summary.tpmsPressureFr, warn: summary.tpmsSoftWarningFr === true },
    { label: "RL", bar: summary.tpmsPressureRl, warn: summary.tpmsSoftWarningRl === true },
    { label: "RR", bar: summary.tpmsPressureRr, warn: summary.tpmsSoftWarningRr === true },
  ].filter((c) => c.bar != null);
  if (corners.length === 0) return null;
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <dt className="text-sm text-muted-foreground">Tyre pressure</dt>
      <dd className="text-sm font-medium tabular-nums">
        {corners.map((corner, i) => (
          <span key={corner.label} className={cn(corner.warn && "text-destructive")}>
            {i > 0 && <span className="text-muted-foreground"> · </span>}
            {corner.label} {u.pressure(corner.bar, settings)}
          </span>
        ))}
      </dd>
    </div>
  );
}

/**
 * The readings the car reports but the card does not lead with — tyres, doors,
 * thermal management, the active route. Collapsed by default so the overview
 * stays an overview; what the card already shows (odometer, power, time to
 * full, updates) is deliberately not repeated here.
 */
export function Diagnostics({ summary, settings }: { summary: CarSummaryDto; settings: GlobalSettingsDto }) {
  const [expanded, setExpanded] = useState(false);

  // Before the first full payload there is nothing to expand into.
  if (summary.dataAt == null) return null;

  const route = summary.activeRoute;
  const stale = summary.state === "asleep" || summary.state === "offline";

  return (
    <div>
      <Button
        variant="ghost"
        size="sm"
        className="w-full justify-between px-0 hover:bg-transparent"
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
      >
        <span className="inline-flex items-center gap-2">
          <Gauge /> Diagnostics
        </span>
        <ChevronDown className={cn("transition-transform", expanded && "rotate-180")} />
      </Button>

      {expanded && (
        <>
          <dl className="divide-y">
            <TyreRow summary={summary} settings={settings} />
            <Row
              label="Doors"
              value={openings([summary.doorDfOpen, summary.doorPfOpen, summary.doorDrOpen, summary.doorPrOpen])}
            />
            <Row
              label="Windows"
              value={openings([summary.windowFdOpen, summary.windowFpOpen, summary.windowRdOpen, summary.windowRpOpen])}
            />
            <Row label="Charge cable" value={summary.connChargeCable} />
            <Row label="Charge rate" value={summary.chargeRateKmh ? u.speed(summary.chargeRateKmh, settings) : null} />
            <Row label="Scheduled charging" value={summary.scheduledChargingPending ? "Pending" : null} />
            <Row label="Trip charging" value={yesNo(summary.tripCharging)} />
            <Row label="Battery heater" value={onOff(summary.batteryHeater)} />
            <Row
              label="Cabin overheat protection"
              value={
                summary.cabinOverheatProtection == null
                  ? null
                  : summary.copActivelyCooling
                    ? `${summary.cabinOverheatProtection} · cooling`
                    : summary.cabinOverheatProtection
              }
            />
            <Row label="Preconditioning" value={onOff(summary.isPreconditioning)} />
            <Row label="Driver temp setting" value={u.temperature(summary.driverTempSetting, settings)} />
            <Row label="Passenger temp setting" value={u.temperature(summary.passengerTempSetting, settings)} />
            <Row label="Auto seat climate left" value={onOff(summary.autoSeatClimateLeft)} />
            <Row label="Auto seat climate right" value={onOff(summary.autoSeatClimateRight)} />
            <Row label="Auto steering wheel heat" value={onOff(summary.autoSteeringWheelHeat)} />
            <Row label="Dashcam" value={summary.dashcamState} />
            {route && (
              <>
                <Row label="Destination" value={route.destination} />
                <Row
                  label="Arrival"
                  value={
                    route.minutesToArrival == null
                      ? null
                      : route.trafficMinutesDelay
                        ? `${u.duration(Math.round(route.minutesToArrival * 60))} · +${Math.round(route.trafficMinutesDelay)} min traffic`
                        : u.duration(Math.round(route.minutesToArrival * 60))
                  }
                />
                <Row label="Distance to arrival" value={u.distance(route.distanceKm, settings, 1)} />
                <Row
                  label="Battery at arrival"
                  value={route.energyAtArrival == null ? null : `${Math.round(route.energyAtArrival)}%`}
                />
              </>
            )}
          </dl>
          {stale && <p className="pt-1 text-xs text-muted-foreground">Last reading {u.since(summary.dataAt)} ago</p>}
        </>
      )}
    </div>
  );
}
