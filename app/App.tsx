import { useEffect, useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Navigate, Route, Routes } from "react-router";
import type { SessionInfo } from "@shared/api-types";
import { api } from "@/lib/api";
import { Shell } from "@/components/Shell";
import { Button } from "@/components/ui/button";
import { SignInPage } from "@/pages/SignIn";
import { ConnectTeslaPage } from "@/pages/ConnectTesla";
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
  });
}

/** The import page without the app shell, for a session with no Tesla account. */
function ImportShell() {
  return (
    <div className="mx-auto max-w-3xl space-y-6 p-4 sm:p-8">
      <ImportPage />
      <p className="text-sm text-muted-foreground">
        <Link to="/" className="underline">
          Connect a Tesla account
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
  if (session.setupRequired) return <SetupPage />;
  if (!session.authenticated) return <SignInPage />;
  if (!session.tesla?.signedIn && !session.connected) {
    // Importing a history is the one thing worth doing before connecting a Tesla
    // account — people arriving from another logger have the export in hand and
    // no reason to link Tesla first.
    return (
      <Routes>
        <Route path="/import" element={<ImportShell />} />
        <Route path="*" element={<ConnectTeslaPage />} />
      </Routes>
    );
  }

  return (
    <Shell
      tesla={session.tesla ?? { signedIn: false, expiresAt: null, lastRefreshAt: null, lastError: null }}
      demo={session.demo}
    >
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
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Shell>
  );
}
