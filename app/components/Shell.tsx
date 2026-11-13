import { useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ChartColumn,
  ChartLine,
  ChevronDown,
  Ellipsis,
  FileText,
  HeartPulse,
  History,
  House,
  LogOut,
  Luggage,
  MapPin,
  PlugZap,
  Route,
  Settings,
  Zap,
} from "lucide-react";
import { Link, useLocation } from "react-router";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useAppSettings } from "@/hooks/useAppSettings";
import { useCar } from "@/hooks/useCar";
import { useSeedTimezone } from "@/hooks/useSeedTimezone";
import { Dialog } from "@/components/ui/dialog";
import { Popover } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { TelemetryPrompts } from "@/components/TelemetryPrompts";
import { ThemeSwitcher } from "@/components/ThemeSwitcher";
import { UpdateToast } from "@/components/UpdateToast";

/**
 * Content width, shared by the header and the page under it so the two line up.
 * Deliberately wider than a reading measure: the filter bars, the nine-column
 * statistics table and the state band all want one row on a laptop, and at the
 * old 64rem the drives filter row wrapped its search box onto a second line by
 * about fifteen pixels.
 *
 * The side padding takes the safe-area inset where there is one, so a phone held
 * sideways keeps the page clear of the notch.
 */
const CONTENT = "mx-auto w-full max-w-[76rem] px-[max(1rem,env(safe-area-inset-left))] sm:px-6";

interface NavItem {
  to: string;
  label: string;
  icon: typeof House;
}

/*
  Ten sections, in three tiers. The four you open most stand on their own; the
  three that read the history back as analysis share a menu; and the three you
  set up once and visit rarely sit with the theme and signing out. Ten links of
  equal weight said nothing about which ones mattered.
*/
const PRIMARY: NavItem[] = [
  { to: "/", label: "Overview", icon: House },
  { to: "/drives", label: "Drives", icon: Route },
  { to: "/charges", label: "Charges", icon: PlugZap },
  { to: "/trips", label: "Trips", icon: Luggage },
];

const INSIGHTS: NavItem[] = [
  { to: "/stats", label: "Statistics", icon: ChartColumn },
  { to: "/health", label: "Health", icon: HeartPulse },
  { to: "/history", label: "History", icon: History },
];

const MORE: NavItem[] = [
  { to: "/geofences", label: "Places", icon: MapPin },
  { to: "/documents", label: "Documents", icon: FileText },
  { to: "/settings", label: "Settings", icon: Settings },
];

/** Highlight the section, including its detail pages. */
function isActive(to: string, pathname: string) {
  return to === "/" ? pathname === "/" : pathname.startsWith(to);
}

/** The bolt in its tile — the same mark as the favicon and the landing page. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "evb-gradient-brand grid size-6 shrink-0 place-items-center rounded-md text-brand-foreground shadow-button",
        className,
      )}
    >
      <Zap className="size-[60%] fill-current" strokeWidth={0} />
    </span>
  );
}

const linkBase =
  "inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 text-sm transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50";
const linkIdle = "text-muted-foreground hover:bg-foreground/5 hover:text-foreground";
const linkActive = "bg-foreground/[0.07] font-medium text-foreground dark:bg-foreground/10";

/**
 * The attention dot: a tyre on the car being looked at is low, very low, high
 * or has lost its sensor. Amber, the colour the chips use for "go and look",
 * ringed in the background so it holds its shape over an icon.
 */
function AttentionDot({ className }: { className?: string }) {
  return (
    <span
      data-testid="tyre-attention-dot"
      className={cn("size-2 shrink-0 rounded-full bg-amber-500 ring-2 ring-background", className)}
      aria-hidden="true"
    />
  );
}

const ATTENTION_TEXT = "A tyre needs attention";

/** One row of a menu: icon, label, and the section's own highlight. */
function MenuLink({
  item,
  active,
  onSelect,
  attention = false,
}: {
  item: NavItem;
  active: boolean;
  onSelect: () => void;
  attention?: boolean;
}) {
  const Icon = item.icon;
  return (
    <Link
      to={item.to}
      viewTransition
      onClick={onSelect}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex items-center gap-3 rounded-lg px-2.5 py-2 text-sm transition-colors",
        active ? "bg-foreground/[0.07] font-medium text-foreground dark:bg-foreground/10" : "hover:bg-foreground/5",
      )}
    >
      <Icon className={cn("size-4", active ? "text-brand" : "text-muted-foreground")} aria-hidden="true" />
      {item.label}
      {attention && (
        <>
          <AttentionDot className="ml-auto" />
          <span className="sr-only">— {ATTENTION_TEXT}</span>
        </>
      )}
    </Link>
  );
}

function MenuHeading({ children }: { children: ReactNode }) {
  return (
    <p className="px-2.5 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
      {children}
    </p>
  );
}

/** A line across the top of every page about an account that needs attention, and where to deal with it. */
export interface ShellNotice {
  text: string;
  to: string;
}

export function Shell({
  notices = [],
  demo,
  children,
}: {
  notices?: ShellNotice[];
  demo?: boolean;
  children: ReactNode;
}) {
  const queryClient = useQueryClient();
  const { pathname } = useLocation();
  const settings = useAppSettings();
  useSeedTimezone(settings.data, demo);
  // Which of the phone's two sheets is up. Every link in one closes it on the
  // way out: a sheet is about getting somewhere, and once there it is done.
  const [sheet, setSheet] = useState<"insights" | "more" | null>(null);

  async function signOut() {
    await api("/api/v1/auth/logout", { method: "DELETE" });
    await queryClient.invalidateQueries({ queryKey: ["session"] });
  }

  const insightsActive = INSIGHTS.some((item) => isActive(item.to, pathname));

  /*
    The Health dot rides on the car list every page already has, so it costs no
    request of its own. It follows the car the pages are showing, and moves with
    the switcher the moment another car is picked.
  */
  const { car: shownCar } = useCar();
  const tyreAttention = shownCar?.tyreAttention ?? false;
  const insightLink = (item: NavItem, close: () => void) => (
    <MenuLink
      key={item.to}
      item={item}
      active={isActive(item.to, pathname)}
      onSelect={close}
      attention={tyreAttention && item.to === "/health"}
    />
  );
  const moreActive = MORE.some((item) => isActive(item.to, pathname));

  // Demo sessions have no password behind them, so there is nothing to sign out of.
  const signOutButton = (onSelect?: () => void) =>
    !demo && (
      <button
        type="button"
        onClick={() => {
          onSelect?.();
          void signOut();
        }}
        className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-sm text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
      >
        <LogOut className="size-4" aria-hidden="true" /> Sign out
      </button>
    );

  const morePanel = (close: () => void) => (
    <>
      {MORE.map((item) => (
        <MenuLink key={item.to} item={item} active={isActive(item.to, pathname)} onSelect={close} />
      ))}
      <div className="my-1.5 border-t" />
      <MenuHeading>Theme</MenuHeading>
      <div className="px-2.5 pb-2 pt-1">
        <ThemeSwitcher compact className="w-full" />
      </div>
      {!demo && <div className="my-1.5 border-t" />}
      {signOutButton(close)}
    </>
  );

  return (
    <div className="evb-page min-h-screen">
      {/*
        Sticky, and translucent over the page: the nav stays within reach on a
        long table, and the blur lets the page's top wash show through it. Below
        md the sections move to the tab bar at the bottom, and this is just the
        mark — the header of an app, not of a website.
      */}
      <header className="evb-header sticky top-0 z-30 border-b border-border/70 bg-background/70 backdrop-blur-xl backdrop-saturate-150">
        <div className={cn(CONTENT, "flex h-14 items-center gap-6")}>
          <Link to="/" viewTransition className="flex items-center gap-2.5 font-semibold tracking-tight">
            <BrandMark />
            EVBook
            {demo && (
              <span className="rounded-full bg-warning/15 px-2 py-px text-[11px] font-medium text-amber-700 ring-1 ring-inset ring-amber-500/25 dark:text-amber-300">
                Demo
              </span>
            )}
          </Link>

          <nav aria-label="Sections" className="hidden flex-1 items-center gap-0.5 md:flex">
            {PRIMARY.map((item) => {
              const active = isActive(item.to, pathname);
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  viewTransition
                  aria-current={active ? "page" : undefined}
                  className={cn(linkBase, active ? linkActive : linkIdle)}
                >
                  {item.label}
                </Link>
              );
            })}
            <Popover
              triggerClassName={cn(linkBase, insightsActive ? linkActive : linkIdle)}
              trigger={(open) => (
                <>
                  Insights
                  {tyreAttention && (
                    <>
                      <AttentionDot />
                      <span className="sr-only">— {ATTENTION_TEXT}</span>
                    </>
                  )}
                  <ChevronDown
                    className={cn("size-3.5 opacity-60 transition-transform", open && "rotate-180")}
                    aria-hidden="true"
                  />
                </>
              )}
            >
              {(close) => INSIGHTS.map((item) => insightLink(item, close))}
            </Popover>
          </nav>

          <Popover
            label="More"
            align="end"
            className="ml-auto hidden md:block"
            panelClassName="w-60"
            triggerClassName={cn(
              "grid size-9 place-items-center rounded-full border bg-card shadow-card transition-colors hover:bg-muted/60",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
              moreActive && "border-brand/40 text-brand",
            )}
            trigger={<Ellipsis className="size-4" aria-hidden="true" />}
          >
            {morePanel}
          </Popover>
        </div>
      </header>

      {notices.map((notice) => (
        <Link
          key={notice.text}
          to={notice.to}
          className="block border-b border-destructive/20 bg-destructive/8 px-4 py-2 text-center text-sm text-destructive hover:bg-destructive/12"
        >
          {notice.text}
        </Link>
      ))}
      {/*
        Pages wait for settings rather than starting without them. Every date
        range resolves against the time zone from settings, and a page that
        mounts first resolves against the browser's, then resolves again a
        moment later against the real one — which meant every list and chart
        fetched itself twice on every load, for two different windows.

        The bottom padding below md is the tab bar's height plus the home
        indicator, so the last row of a page is never under the bar.
      */}
      <main className={cn(CONTENT, "pb-[calc(6rem+env(safe-area-inset-bottom))] pt-6 md:pb-14 md:pt-10")}>
        {settings.data ? children : <Skeleton className="h-96" />}
      </main>

      {/*
        The phone's navigation: the three sections you open most, then the two
        menus as sheets that rise from the bar. At the bottom because that is
        where a thumb is; the header used to hold all ten in a row that scrolled
        sideways and cut its last label in half.
      */}
      <nav
        aria-label="Sections"
        className="evb-tabbar fixed inset-x-0 bottom-0 z-30 border-t border-border/70 bg-background/80 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl backdrop-saturate-150 md:hidden"
      >
        <div className="mx-auto grid h-16 max-w-md grid-cols-5 px-2">
          {PRIMARY.slice(0, 3).map((item) => (
            <TabLink key={item.to} item={item} active={isActive(item.to, pathname)} />
          ))}
          <TabButton
            label="Insights"
            icon={ChartLine}
            active={insightsActive}
            expanded={sheet === "insights"}
            onClick={() => setSheet("insights")}
            attention={tyreAttention}
          />
          <TabButton
            label="More"
            icon={Ellipsis}
            active={moreActive || isActive("/trips", pathname)}
            expanded={sheet === "more"}
            onClick={() => setSheet("more")}
          />
        </div>
      </nav>

      <Dialog
        open={sheet !== null}
        onClose={() => setSheet(null)}
        className="evb-sheet mb-0 mt-auto max-w-none rounded-b-none border-x-0 border-b-0 px-3 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-2 md:hidden"
      >
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-muted-foreground/30" aria-hidden="true" />
        <MenuHeading>{sheet === "insights" ? "Insights" : "More"}</MenuHeading>
        {sheet === "insights" ? (
          INSIGHTS.map((item) => insightLink(item, () => setSheet(null)))
        ) : (
          <>
            <MenuLink item={PRIMARY[3]!} active={isActive("/trips", pathname)} onSelect={() => setSheet(null)} />
            {morePanel(() => setSheet(null))}
          </>
        )}
      </Dialog>

      {/* Outside `main`, and last: it floats over the page and is the least
          important thing on it. It renders nothing unless there is an update
          the reader has not already waved away. */}
      <UpdateToast />
      {/* Crash toast and post-update survey. Mounted only once telemetry is
          switched on in Settings — and never in the demo, whose visitors are
          not the instance's owner and have nothing to opt into. */}
      <TelemetryPrompts enabled={!demo && settings.data != null && settings.data.telemetryLevel !== "off"} />
    </div>
  );
}

const tabBase =
  "flex flex-col items-center justify-center gap-1 rounded-lg text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50";

function TabLink({ item, active }: { item: NavItem; active: boolean }) {
  const Icon = item.icon;
  return (
    <Link
      to={item.to}
      viewTransition
      aria-current={active ? "page" : undefined}
      className={cn(tabBase, active ? "text-foreground" : "text-muted-foreground")}
    >
      <Icon className={cn("size-5", active && "text-brand")} strokeWidth={active ? 2.25 : 1.75} aria-hidden="true" />
      {item.label}
    </Link>
  );
}

function TabButton({
  label,
  icon: Icon,
  active,
  expanded,
  onClick,
  attention = false,
}: {
  label: string;
  icon: typeof House;
  active: boolean;
  expanded: boolean;
  onClick: () => void;
  attention?: boolean;
}) {
  return (
    <button
      type="button"
      aria-expanded={expanded}
      onClick={onClick}
      className={cn(tabBase, active ? "text-foreground" : "text-muted-foreground")}
    >
      <span className="relative">
        <Icon className={cn("size-5", active && "text-brand")} strokeWidth={active ? 2.25 : 1.75} aria-hidden="true" />
        {attention && <AttentionDot className="absolute -right-1 -top-0.5" />}
      </span>
      {label}
      {attention && <span className="sr-only">— {ATTENTION_TEXT}</span>}
    </button>
  );
}
