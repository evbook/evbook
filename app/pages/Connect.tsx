import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { Link, Navigate, useNavigate, useParams, useSearchParams } from "react-router";
import type { AccountDto, Provider } from "@shared/api-types";
import { api } from "@/lib/api";
import { MAKES, makeOf, type Make } from "@/lib/makes";
import { useAppSettings } from "@/hooks/useAppSettings";
import { AuthFrame } from "@/components/AuthFrame";
import { MakeMark } from "@/components/MakeMark";
import { PageHeader } from "@/components/PageHeader";
import { TeslaConnect } from "@/components/TeslaConnect";
import { VolvoConnect, VOLVO_OUTCOMES } from "@/components/VolvoConnect";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * Adding a car, in two steps that are the same on a first run and ever after:
 * pick the make, then do what that make's sign-in takes.
 *
 *   /connect            the makes
 *   /connect/:make      that make's connection — setting it up, and for a make
 *                       with one connection, managing it afterwards
 *
 * On a first run (`firstRun`) there is no app around it yet, so both steps sit
 * in the frame the password screen uses. Once a car is connected the same two
 * steps are a page of the app, reached from Settings.
 */

interface ConnectorProps {
  firstRun: boolean;
  /** For the dates a connection shows: the instance's zone, or the browser's before there are settings. */
  timezone: string;
}

function TeslaConnector(_: ConnectorProps) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  // The overview is the confirmation: the account's cars are on it.
  return <TeslaConnect account={params.get("account")} onDone={() => void navigate("/")} />;
}

function VolvoConnector({ firstRun, timezone }: ConnectorProps) {
  const [params] = useSearchParams();
  const outcome = params.get("outcome");
  return (
    <div className="space-y-4">
      <VolvoConnect timezone={timezone} outcome={outcome} />
      {!firstRun && outcome && VOLVO_OUTCOMES[outcome]?.ok && (
        <Link to="/" className={cn(buttonVariants({ size: "sm" }))}>
          Go to the overview
        </Link>
      )}
    </div>
  );
}

/** Keyed by `Provider`, so a make added to the type does not compile until it can be connected. */
const CONNECTORS: Record<Provider, (props: ConnectorProps) => ReactNode> = {
  tesla: TeslaConnector,
  volvo: VolvoConnector,
};

/** What a make's row says under its name, given what is already connected. */
function pickerLine(make: Make, accounts: AccountDto[]): { text: string; badge: string | null } {
  const mine = accounts.filter((a) => a.provider === make.id && (a.signedIn || a.pending || a.cars > 0));
  if (mine.length === 0) return { text: make.needs, badge: null };
  if (mine.some((a) => a.pending)) return { text: "Started, but not signed in yet.", badge: "Not finished" };
  if (!mine.some((a) => a.signedIn)) return { text: "Signed out. Sign in again to keep logging.", badge: "Signed out" };
  return {
    text: make.multiple
      ? `Add another ${make.account}'s cars.`
      : `One ${make.account} reads all its cars. Open it to look for a new one.`,
    badge: "Connected",
  };
}

function MakePicker({ accounts }: { accounts: AccountDto[] }) {
  return (
    <ul className="space-y-2">
      {MAKES.map((make) => {
        const line = pickerLine(make, accounts);
        return (
          <li key={make.id}>
            <Link
              to={`/connect/${make.id}`}
              className={cn(
                "group flex items-center gap-4 rounded-xl border bg-card p-3.5 transition-colors",
                "hover:border-brand/40 hover:bg-muted/40",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
              )}
            >
              <MakeMark make={make} />
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2 font-medium">
                  {make.name}
                  {line.badge && (
                    <Badge variant={line.badge === "Connected" ? "success" : "secondary"}>{line.badge}</Badge>
                  )}
                </span>
                <span className="block text-sm text-muted-foreground text-pretty">{line.text}</span>
              </span>
              <ChevronRight
                className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5"
                aria-hidden="true"
              />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

export function ConnectPage({ firstRun }: { firstRun: boolean }) {
  const { make: makeId } = useParams();
  const make = makeOf(makeId);
  // Not asked for on a first run: nothing is connected, so there is nothing to mark.
  const accounts = useQuery({
    queryKey: ["accounts"],
    queryFn: () => api<AccountDto[]>("/api/v1/accounts"),
    enabled: !firstRun && !make,
  });
  const settings = useAppSettings();
  const timezone = settings.data?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  if (makeId && !make) return <Navigate to="/connect" replace />;
  const Connector = make ? CONNECTORS[make.id] : null;

  if (firstRun) {
    if (!make || !Connector) {
      return (
        <AuthFrame
          width="lg"
          title="Connect your car"
          description="Which make is it? More than one car is fine: start with any, and add the rest from Settings."
        >
          <MakePicker accounts={[]} />
          <p className="mt-5 text-center text-sm text-muted-foreground">
            Coming from another logger?{" "}
            <Link to="/import" className="font-medium text-foreground underline underline-offset-4">
              Import your history
            </Link>{" "}
            first — no account needed.
          </p>
        </AuthFrame>
      );
    }
    return (
      <AuthFrame width="lg" title={`Connect your ${make.name}`} description={make.intro}>
        <Link
          to="/connect"
          className="-mt-1 mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="size-4" aria-hidden="true" /> Another make
        </Link>
        <Connector firstRun timezone={timezone} />
      </AuthFrame>
    );
  }

  const crumb = (to: string, label: string) => (
    <Link to={to} className="inline-flex items-center gap-1 hover:text-foreground">
      <ChevronLeft className="size-4" aria-hidden="true" /> {label}
    </Link>
  );

  if (!make || !Connector) {
    return (
      <div className="space-y-6">
        <PageHeader
          eyebrow={crumb("/settings#accounts", "Settings")}
          title="Add a car"
          description="Pick the make. Each is read through its maker's own service, and logged beside the cars you already have."
        />
        <div className="max-w-2xl">
          <MakePicker accounts={accounts.data ?? []} />
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-6">
      <PageHeader eyebrow={crumb("/connect", "Add a car")} title={make.name} description={make.intro} />
      <Card className="max-w-2xl">
        <CardContent className="pt-6">
          <Connector firstRun={false} timezone={timezone} />
        </CardContent>
      </Card>
    </div>
  );
}
