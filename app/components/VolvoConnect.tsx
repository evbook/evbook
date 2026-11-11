import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy } from "lucide-react";
import { useState, type FormEvent } from "react";
import type { VolvoStatusDto } from "@shared/api-types";
import { api, ApiRequestError } from "@/lib/api";
import { dateTime } from "@/lib/format";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

type VolvoInfo = VolvoStatusDto & { redirectUri: string };

const PORTAL_URL = "https://developer.volvocars.com/account/";

/** What `/settings?volvo=…` means, from the consent's callback. */
export const VOLVO_OUTCOMES: Record<string, { ok: boolean; text: string }> = {
  connected: { ok: true, text: "Volvo connected. The first readings arrive within a minute." },
  key_refused: {
    ok: false,
    text: "Signed in, but Volvo refused the API key. A key minutes old is often refused for its first hour — try Find cars again later, or check the key.",
  },
  no_vehicle: { ok: false, text: "Signed in, but this Volvo ID has no car attached to it." },
  not_configured: { ok: false, text: "Save the Volvo application's credentials first." },
  denied: { ok: false, text: "The Volvo ID sign-in was cancelled." },
  state_mismatch: {
    ok: false,
    text: "That sign-in did not start in this browser, or took too long. Start it again from here.",
  },
  failed: { ok: false, text: "Volvo did not complete the sign-in. The details are below." },
  unavailable: { ok: false, text: "Signed in, but Volvo's API did not answer. Try Find cars in a minute." },
  not_connected: { ok: false, text: "Not signed in to Volvo ID." },
};

function CopyField({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1.5 text-xs">{value}</code>
      <Button
        type="button"
        variant="outline"
        size="sm"
        aria-label="Copy the redirect URI"
        onClick={() => {
          void navigator.clipboard?.writeText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? <Check /> : <Copy />}
      </Button>
    </div>
  );
}

/**
 * Connecting a Volvo, start to finish: the developer application's credentials,
 * the redirect URI to register with it, the Volvo ID consent, and the state of
 * the grant afterwards. Used by Settings and by the first-run connect screen.
 */
export function VolvoConnect({ timezone, outcome }: { timezone: string; outcome?: string | null }) {
  const queryClient = useQueryClient();
  const info = useQuery({ queryKey: ["volvo"], queryFn: () => api<VolvoInfo>("/api/v1/volvo") });
  const [editing, setEditing] = useState(false);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [scopes, setScopes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["volvo"] });
    void queryClient.invalidateQueries({ queryKey: ["accounts"] });
    void queryClient.invalidateQueries({ queryKey: ["cars"] });
  };
  const failure = (err: unknown, fallback: string) =>
    setError(err instanceof ApiRequestError && err.message ? err.message : fallback);

  const save = useMutation({
    mutationFn: () =>
      api<VolvoStatusDto>("/api/v1/volvo/credentials", {
        method: "PUT",
        body: JSON.stringify({ clientId, clientSecret, apiKey, scopes }),
      }),
    onSuccess: () => {
      setEditing(false);
      setClientSecret("");
      setApiKey("");
      setError(null);
      refresh();
    },
    onError: (err) => failure(err, "The credentials could not be saved."),
  });
  const findCars = useMutation({
    mutationFn: () => api<{ outcome: string; vins: number }>("/api/v1/volvo/vehicles", { method: "POST" }),
    onSuccess: (r) => {
      setError(null);
      setNotice(`Found ${r.vins} car${r.vins === 1 ? "" : "s"}.`);
      refresh();
    },
    onError: async (err) => {
      setNotice(null);
      failure(err, "Volvo did not list the cars.");
      refresh();
    },
  });
  const disconnect = useMutation({
    mutationFn: () => api("/api/v1/volvo/connection", { method: "DELETE" }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: () => api("/api/v1/volvo/credentials", { method: "DELETE" }),
    onSuccess: () => {
      setConfirmRemove(false);
      refresh();
      void queryClient.invalidateQueries({ queryKey: ["session"] });
    },
  });

  if (!info.data) {
    return (
      <p className="text-sm text-muted-foreground">
        {info.isError ? "Could not load the Volvo connection." : "Loading…"}
      </p>
    );
  }
  const v = info.data;
  const showForm = editing || !v.configured;
  const banner = outcome ? VOLVO_OUTCOMES[outcome] : undefined;

  function submit(e: FormEvent) {
    e.preventDefault();
    save.mutate();
  }

  return (
    <div className="space-y-4 text-sm">
      {banner && (
        <p
          className={cn("rounded-md px-3 py-2", banner.ok ? "bg-emerald-500/10" : "bg-destructive/10 text-destructive")}
        >
          {banner.text}
        </p>
      )}

      <div className="space-y-1.5">
        <p className="font-medium">Redirect URI</p>
        <p className="text-muted-foreground">
          Register this exactly on your application at{" "}
          <a href={PORTAL_URL} target="_blank" rel="noreferrer" className="underline underline-offset-4">
            developer.volvocars.com
          </a>
          .
        </p>
        <CopyField value={v.redirectUri} />
      </div>

      {showForm ? (
        <form onSubmit={submit} className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="volvo-client-id">Client ID</Label>
              <Input
                id="volvo-client-id"
                value={clientId}
                placeholder={v.clientId ?? "vid-dc-…"}
                onChange={(e) => setClientId(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="volvo-client-secret">Client secret</Label>
              <Input
                id="volvo-client-secret"
                type="password"
                value={clientSecret}
                placeholder={v.configured ? "Unchanged" : ""}
                onChange={(e) => setClientSecret(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="volvo-api-key">API key (vcc-api-key)</Label>
              <Input
                id="volvo-api-key"
                type="password"
                value={apiKey}
                placeholder={v.apiKeyLast4 ? `…${v.apiKeyLast4} (unchanged)` : ""}
                onChange={(e) => setApiKey(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="volvo-scopes">Scopes</Label>
              <Input
                id="volvo-scopes"
                value={scopes}
                placeholder="EVBook's read-only list"
                onChange={(e) => setScopes(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Leave Scopes empty unless your application lacks one of them (location:read can be under review) or offers
            offline_access. They must match what the application was published with, or Volvo ID refuses the sign-in.
          </p>
          {error && <p className="text-destructive">{error}</p>}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" disabled={save.isPending || (!clientId && !v.configured)}>
              {save.isPending ? "Saving…" : "Save"}
            </Button>
            {v.configured && (
              <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            )}
          </div>
        </form>
      ) : (
        <div className="space-y-3">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
            <dt className="text-muted-foreground">Client ID</dt>
            <dd className="truncate">{v.clientId}</dd>
            <dt className="text-muted-foreground">API key</dt>
            <dd>…{v.apiKeyLast4}</dd>
            <dt className="text-muted-foreground">Volvo ID</dt>
            <dd>
              {v.connected
                ? `Connected since ${dateTime(v.authorizedAt, timezone)}`
                : v.reauthReason
                  ? "The sign-in lapsed — connect again"
                  : "Not connected"}
            </dd>
            {v.connected && v.refreshExpiresAt && (
              <>
                <dt className="text-muted-foreground">Session</dt>
                <dd>Renewed automatically; lapses if unused until {dateTime(v.refreshExpiresAt, timezone)}</dd>
              </>
            )}
          </dl>
          {v.connected && v.grantAging && (
            <p className="rounded-md bg-amber-500/10 px-3 py-2">
              This Volvo ID consent is nearly six months old. Volvo may end it soon — reconnect now and nothing is
              missed.
            </p>
          )}
          {v.lastError && <p className="text-xs text-muted-foreground">Last problem: {v.lastError}</p>}
          {notice && <p className="text-muted-foreground">{notice}</p>}
          {error && <p className="text-destructive">{error}</p>}
          <div className="flex flex-wrap gap-2">
            <a
              href="/api/v1/auth/volvo/start"
              className={cn(buttonVariants({ size: "sm", variant: v.connected ? "outline" : "default" }))}
            >
              {v.connected ? "Reconnect Volvo ID" : "Connect with Volvo ID"}
            </a>
            {v.connected && (
              <Button variant="outline" size="sm" disabled={findCars.isPending} onClick={() => findCars.mutate()}>
                {findCars.isPending ? "Asking Volvo…" : "Find cars"}
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
              Edit credentials
            </Button>
            {v.connected && (
              <Button variant="ghost" size="sm" disabled={disconnect.isPending} onClick={() => disconnect.mutate()}>
                Disconnect
              </Button>
            )}
            {confirmRemove ? (
              <>
                <Button variant="destructive" size="sm" disabled={remove.isPending} onClick={() => remove.mutate()}>
                  Yes, remove
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setConfirmRemove(false)}>
                  Keep
                </Button>
              </>
            ) : (
              <Button variant="ghost" size="sm" onClick={() => setConfirmRemove(true)}>
                Remove application
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
