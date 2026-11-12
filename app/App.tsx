import { useEffect, useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Navigate, Route, Routes } from "react-router";
import type { SessionInfo } from "@shared/api-types";
import { api } from "@/lib/api";
import { Shell, type ShellNotice } from "@/components/Shell";
import { Button } from "@/components/ui/button";
import { SignInPage } from "@/pages/SignIn";
import { ConnectPage } from "@/pages/Connect";
import { OverviewPage } from "@/pages/Overview";
import { DrivesPage } from "@/pages/Drives";
import { DriveDetailPage } from "@/pages/DriveDetail";
import { ChargesPage } from "@/pages/Charges";
import { ChargeDetailPage } from "@/pages/ChargeDetail";
import { GeofencesPage } from "@/pages/Geofences";
import { GeofenceFormPage } from "@/pages/GeofenceForm";
import { HistoryPage } from "@/pages/History";
import { TripsPage } from "@/pages/Trips";
import { StatisticsPage } from "@/pages/Statistics";
import { HealthPage } from "@/pages/Health";
import { DocumentsPage } from "@/pages/Documents";
import { SettingsPage } from "@/pages/Settings";
import { ImportPage } from "@/pages/Import";
import { SetupPage } from "@/pages/Setup";

function useSession() {
  return useQuery({
    queryKey: ["session"],
    queryFn: () => api<SessionInfo>("/api/v1/session"),
    // The setup screen is waiting for someone to set a secret in a terminal.
    // Asking again is how it notices, so nobody has to come back and reload.
    refetchInterval: (query) => (query.state.data?.setupRequired ? 4000 : false),
  });
}

/** The import page without the app shell, for a session with no car connected. */
function ImportShell() {
  return (
    <div className="mx-auto max-w-3xl space-y-6 p-4 sm:p-8">
      <ImportPage />
      <p className="text-sm text-muted-foreground">
        <Link to="/" className="underline">
          Connect your car
        </Link>{" "}
        to browse an imported history and start logging.
      </p>
    </div>
  );
}

function subscribeToConnection(onChange: () => void) {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

/**
 * The shell is precached by the service worker, so an installed app opens with
 * no network at all — and this is then the only thing it can show, because the
 * logbook itself is deliberately never cached. Which of the two failures it is
 * decides what to do about it: a dead spot clears on its own and this screen
 * will notice, a server that is not answering needs someone to look at it.
 */
function Unreachable() {
  const queryClient = useQueryClient();
  const online = useSyncExternalStore(subscribeToConnection, () => navigator.onLine);

  // Coming back into signal is the retry. Nobody should have to find the button.
  useEffect(() => {
    const retry = () => void queryClient.invalidateQueries({ queryKey: ["session"] });
    window.addEventListener("online", retry);
    return () => window.removeEventListener("online", retry);
  }, [queryClient]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-3 px-4 text-center">
      <p className="font-medium">{online ? "EVBook is not answering." : "You are offline."}</p>
      <p className="max-w-sm text-sm text-muted-foreground">
        {online
          ? "The app loaded, but the server did not respond. It may be restarting."
          : "The app opens without a connection, but your drives and charges live on the server. It will reload itself when you are back in signal."}
      </p>
      <Button variant="outline" size="sm" onClick={() => void queryClient.invalidateQueries({ queryKey: ["session"] })}>
        Try again
      </Button>
    </div>
  );
}

/**
 * What is wrong with an account, said on every page: a car that has stopped
 * being read is not something to find out about on the Settings page. One line
 * per account, each leading to where it is put right.
 */
function accountNotices(session: SessionInfo): ShellNotice[] {
  const notices: ShellNotice[] = [];
  if (session.tesla?.lastError)
    notices.push({ text: `Tesla API: ${session.tesla.lastError}`, to: "/settings#accounts" });
  if (session.volvo?.reauthReason) {
    notices.push({
      text: "Volvo: the Volvo ID sign-in has lapsed. Sign in again to keep logging.",
      to: "/connect/volvo",
    });
  }
  return notices;
}

export function App() {
  const { data: session, isLoading } = useSession();

  if (isLoading) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 text-muted-foreground">
        <span className="evb-spinner" aria-hidden="true" />
        <span className="text-sm">Loading…</span>
      </div>
    );
  }
  if (!session) return <Unreachable />;
  if (session.setupRequired) return <SetupPage setup={session.setup} />;
  if (!session.authenticated) return <SignInPage />;
  if (!session.tesla?.signedIn && !session.connected) {
    // Importing a history is the one thing worth doing before connecting a car
    // — people arriving from another logger have the export in hand and no
    // reason to link an account first.
    return (
      <Routes>
        <Route path="/import" element={<ImportShell />} />
        <Route path="/connect/:make" element={<ConnectPage firstRun />} />
        <Route path="*" element={<ConnectPage firstRun />} />
      </Routes>
    );
  }

  return (
    <Shell notices={accountNotices(session)} demo={session.demo}>
      <Routes>
        <Route path="/" element={<OverviewPage />} />
        <Route path="/drives" element={<DrivesPage />} />
        <Route path="/drives/:id" element={<DriveDetailPage />} />
        <Route path="/charges" element={<ChargesPage />} />
        <Route path="/charges/:id" element={<ChargeDetailPage />} />
        <Route path="/geofences" element={<GeofencesPage />} />
        <Route path="/geofences/new" element={<GeofenceFormPage />} />
        <Route path="/geofences/:id" element={<GeofenceFormPage />} />
        <Route path="/trips" element={<TripsPage />} />
        <Route path="/history" element={<HistoryPage />} />
        <Route path="/stats" element={<StatisticsPage />} />
        <Route path="/health" element={<HealthPage />} />
        <Route path="/documents" element={<DocumentsPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/import" element={<ImportPage />} />
        <Route path="/connect" element={<ConnectPage firstRun={false} />} />
        <Route path="/connect/:make" element={<ConnectPage firstRun={false} />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Shell>
  );
}
