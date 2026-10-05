import type { ReactNode } from "react";
import {
  AlertTriangle,
  ArrowDownToLine,
  DoorOpen,
  Fan,
  Lock,
  LockOpen,
  Package,
  PawPrint,
  Plug,
  Shield,
  Snowflake,
  UserRound,
  Wind,
} from "lucide-react";
import type { CarSummaryDto } from "@shared/api-types";
import { cn } from "@/lib/utils";
import { pressure, type Units } from "@/lib/units";

/**
 * How much a condition asks of the reader. Most are just facts — locked, sentry
 * on — and stay quiet; an open door or a low tyre is something to go and do
 * something about, and only those take a colour.
 */
type Tone = "quiet" | "info" | "attention" | "fault";

const TONES: Record<Tone, string> = {
  quiet: "bg-foreground/[0.045] text-muted-foreground dark:bg-foreground/[0.07]",
  info: "bg-brand/10 text-brand",
  attention: "bg-warning/15 text-amber-700 dark:text-amber-300",
  fault: "bg-destructive/12 text-destructive",
};

/**
 * The condition strip from TeslaMate's car card: only states worth noticing are
 * rendered. Each is a labelled chip rather than a bare icon — a padlock and a
 * shield in grey were a row of glyphs to decode, and a warning triangle on its own
 * said that something was wrong without saying what. The full sentence stays in
 * the tooltip.
 */
export function StatusChips({ summary, units }: { summary: CarSummaryDto; units: Units }) {
  const chips: { key: string; label: string; title: string; tone: Tone; icon: ReactNode }[] = [];
  const add = (key: string, label: string, title: string, tone: Tone, icon: ReactNode) =>
    chips.push({ key, label, title, tone, icon });

  if (summary.chargePortDoorOpen && summary.chargingState !== "Disconnected") {
    add("plug", "Plugged in", `Plugged in${summary.chargingState ? ` (${summary.chargingState})` : ""}`, "info", <Plug />);
  }
  if (summary.locked === false) add("unlocked", "Unlocked", "Unlocked", "attention", <LockOpen />);
  if (summary.locked === true) add("locked", "Locked", "Locked", "quiet", <Lock />);
  if (summary.sentryMode) add("sentry", "Sentry", "Sentry mode is enabled", "quiet", <Shield />);
  if (summary.isUserPresent) add("user", "Driver present", "Driver is present", "quiet", <UserRound />);
  if (summary.isPreconditioning) add("precondition", "Preconditioning", "Preconditioning", "info", <Fan />);
  else if (summary.isClimateOn) add("climate", "Climate on", "Climate is on", "info", <Wind />);
  if (summary.doorsOpen) add("doors", "Door open", "A door is open", "attention", <DoorOpen />);
  if (summary.trunkOpen) add("trunk", "Trunk open", "A trunk is open", "attention", <Package />);
  if (summary.windowsOpen) add("windows", "Window open", "A window is open", "attention", <Wind />);
  if (summary.updateAvailable) {
    add(
      "update",
      "Update ready",
      `Software update available${summary.updateVersion ? `: ${summary.updateVersion}` : ""}`,
      "info",
      <ArrowDownToLine />,
    );
  }
  if (summary.state === "updating") add("updating", "Updating", "Installing a software update", "info", <ArrowDownToLine />);

  // A usable level well below the nominal level means range is cold-limited.
  if (
    summary.batteryLevel != null &&
    summary.usableBatteryLevel != null &&
    summary.batteryLevel - summary.usableBatteryLevel > 2
  ) {
    add("reduced", "Cold battery", "Range is reduced — the battery is cold", "info", <Snowflake />);
  }

  const tpms = [
    ["Front left", summary.tpmsPressureFl],
    ["Front right", summary.tpmsPressureFr],
    ["Rear left", summary.tpmsPressureRl],
    ["Rear right", summary.tpmsPressureRr],
  ] as const;
  const lowTyres = tpms.filter(([, bar]) => bar != null && bar < 2.5);
  if (lowTyres.length > 0) {
    add(
      "tpms",
      "Low tyre",
      `Low tyre pressure — ${lowTyres.map(([label, bar]) => `${label}: ${pressure(bar, units)}`).join(", ")}`,
      "attention",
      <AlertTriangle />,
    );
  }
  if (!summary.healthy) add("health", "Check failed", summary.lastError ?? "Health check failed", "fault", <AlertTriangle />);
  if (summary.state === "charging" && summary.chargerPower === 0) {
    add("dogmode", "Waiting to charge", "Waiting to charge", "quiet", <PawPrint />);
  }

  if (chips.length === 0) return null;

  return (
    <ul className="flex flex-wrap items-center gap-1.5" aria-label="Car condition">
      {chips.map(({ key, label, title, tone, icon }) => (
        <li
          key={key}
          title={title}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium [&_svg]:size-3.5",
            TONES[tone],
          )}
        >
          {icon}
          {label}
        </li>
      ))}
    </ul>
  );
}
