import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import type { VolvoLinkMode, VolvoStatusDto } from "@shared/api-types";
import { api, ApiRequestError } from "@/lib/api";

import { CopyField } from "@/components/CopyField";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { formatDate } from "@/lib/datetime";
import { DateTime } from "@/components/DateTime";

type VolvoInfo = VolvoStatusDto & { redirectUri: string };

const PORTAL_URL = "https://developer.volvocars.com/account/";
const SIGN_IN_URL = "/api/v1/auth/volvo/start";

/** What `/connect/volvo?outcome=…` means, from the consent's callback. */
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

/**
 * Connecting a Volvo, start to finish: the developer application's credentials,
 * the redirect URI to register with it, the Volvo ID consent, and the state of
 * the grant afterwards. The whole of `/connect/volvo`, on a first run and after.
 *
 * Saving is not a step of its own. Until there is a grant, the form's button
 * saves and goes straight on to Volvo ID; once there is one, it saves and asks
 * Volvo for the cars again — which is why anyone changes a key.
 */
export function VolvoConnect({ timezone, outcome }: { timezone: string; outcome?: string | null }) {
  const queryClient = useQueryClient();
  const info = useQuery({ queryKey: ["volvo"], queryFn: () => api<VolvoInfo>("/api/v1/volvo") });
  const [editing, setEditing] = useState(false);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [scopes, setScopes] = useState("");
  /** The sign-in the form is set up for, when the owner switched it; else the saved one. */
  const [formMode, setFormMode] = useState<VolvoLinkMode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  /** On the way to Volvo ID: the page is about to be replaced, so nothing on it should invite a second click. */
  const [leaving, setLeaving] = useState(false);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["volvo"] });
    void queryClient.invalidateQueries({ queryKey: ["accounts"] });
    void queryClient.invalidateQueries({ queryKey: ["cars"] });
  };
  const failure = (err: unknown, fallback: string) =>
    setError(err instanceof ApiRequestError && err.message ? err.message : fallback);

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
  const save = useMutation({
    mutationFn: (mode: VolvoLinkMode) =>
      api<VolvoStatusDto>("/api/v1/volvo/credentials", {
        method: "PUT",
        body: JSON.stringify(mode === "linked" ? { mode, apiKey } : { mode, clientId, clientSecret, apiKey, scopes }),
      }),
    onSuccess: (saved) => {
      setError(null);
      if (!saved.connected) {
        setLeaving(true);
        window.location.assign(SIGN_IN_URL);
        return;
      }
      setEditing(false);
      setFormMode(null);
      setClientSecret("");
      setApiKey("");
      refresh();
      findCars.mutate();
    },
    onError: (err) => failure(err, "The credentials could not be saved."),
  });
  const disconnect = useMutation({
    mutationFn: () => api("/api/v1/volvo/connection", { method: "DELETE" }),
    onSuccess: () => {
      refresh();
      void queryClient.invalidateQueries({ queryKey: ["session"] });
    },
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
  const mode: VolvoLinkMode = showForm ? (formMode ?? v.mode) : v.mode;
  const linkHost = v.linkUrl ? new URL(v.linkUrl).host : null;
  const savedAs = (m: VolvoLinkMode) => v.configured && v.mode === m;
  const saving = save.isPending || leaving;
  const saveLabel = leaving
    ? "Opening Volvo ID…"
    : save.isPending
      ? "Saving…"
      : v.connected
        ? "Save"
        : "Continue to Volvo ID";

  function submit(e: FormEvent) {
    e.preventDefault();
    save.mutate(mode);
  }

  const switcher =
    showForm && v.linkUrl ? (
      <button
        type="button"
        className="text-xs text-muted-foreground underline underline-offset-4"
        onClick={() => {
          setFormMode(mode === "linked" ? "own" : "linked");
          setError(null);
        }}
      >
        {mode === "linked" ? "Use my own Volvo application instead" : `Sign in through ${linkHost} instead`}
      </button>
    ) : null;

  return (
    <div className="space-y-4 text-sm">
      {banner && (
        <p
          className={cn("rounded-md px-3 py-2", banner.ok ? "bg-emerald-500/10" : "bg-destructive/10 text-destructive")}
        >
          {banner.text}
        </p>
      )}

      {mode === "own" && (
        <div className="space-y-1.5">
          <p className="font-medium">Redirect URI</p>
          <p className="text-muted-foreground">
            Register this exactly on your application at{" "}
            <a href={PORTAL_URL} target="_blank" rel="noreferrer" className="underline underline-offset-4">
              developer.volvocars.com
            </a>
            .
          </p>
          <CopyField value={v.redirectUri} label="Copy the redirect URI" />
        </div>
      )}

      {showForm && mode === "linked" ? (
        <form onSubmit={submit} className="space-y-3">
          <ol className="list-decimal space-y-1.5 pl-5 text-muted-foreground">
            <li>
              Create a free API application at{" "}
              <a href={PORTAL_URL} target="_blank" rel="noreferrer" className="underline underline-offset-4">
                developer.volvocars.com
              </a>{" "}
              and copy its <span className="text-foreground">VCC API key</span>.
            </li>
            <li>Paste the key here.</li>
            <li>
              Sign in with your Volvo ID. That goes through{" "}
              <a href={v.linkUrl ?? "#"} target="_blank" rel="noreferrer" className="underline underline-offset-4">
                {linkHost}
              </a>
              , which holds EVBook&apos;s Volvo application and stores nothing.
            </li>
          </ol>
          <div className="space-y-1.5 sm:max-w-sm">
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
            <p className="text-xs text-muted-foreground">
              Volvo counts calls per key, so each owner brings their own. Readings go straight from this EVBook to
              Volvo.
            </p>
          </div>
          {error && <p className="text-destructive">{error}</p>}
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" size="sm" disabled={saving || (!apiKey && !savedAs("linked") && !v.apiKeyLast4)}>
              {saveLabel}
            </Button>
            {v.configured && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setEditing(false);
                  setFormMode(null);
                }}
              >
                Cancel
              </Button>
            )}
            {switcher}
          </div>
        </form>
      ) : showForm ? (
        <form onSubmit={submit} className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="volvo-client-id">Client ID</Label>
              <Input
                id="volvo-client-id"
                value={clientId}
                placeholder={v.clientId ?? "vid-…"}
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
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" size="sm" disabled={saving || (!clientId && !savedAs("own"))}>
              {saveLabel}
            </Button>
            {v.configured && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setEditing(false);
                  setFormMode(null);
                }}
              >
                Cancel
              </Button>
            )}
            {switcher}
          </div>
        </form>
      ) : (
        <div className="space-y-3">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
            <dt className="text-muted-foreground">Sign-in</dt>
            <dd className="truncate">
              {v.mode === "linked"
                ? `Through ${linkHost ?? "EVBook's account linking"}`
                : `Own application ${v.clientId}`}
            </dd>
            <dt className="text-muted-foreground">API key</dt>
            <dd>…{v.apiKeyLast4}</dd>
            <dt className="text-muted-foreground">Volvo ID</dt>
            <dd>
              {v.connected
                ? `Connected since ${formatDate(v.authorizedAt, "dateTime", timezone)}`
                : v.reauthReason
                  ? "The sign-in lapsed — connect again"
                  : "Not connected"}
            </dd>
            {v.connected && v.refreshExpiresAt && (
              <>
                <dt className="text-muted-foreground">Session</dt>
                <dd>
                  Renewed automatically; lapses if unused until <DateTime at={v.refreshExpiresAt} />
                </dd>
              </>
            )}
          </dl>
          {v.connected && v.grantAging && (
            <p className="rounded-md bg-amber-500/10 px-3 py-2">
              This Volvo ID consent is nearly three months old. Volvo may end it soon — reconnect now and nothing is
              missed.
            </p>
          )}
          {v.lastError && <p className="text-xs text-muted-foreground">Last problem: {v.lastError}</p>}
          {notice && <p className="text-muted-foreground">{notice}</p>}
          {error && <p className="text-destructive">{error}</p>}
          <div className="flex flex-wrap gap-2">
            <a
              href={SIGN_IN_URL}
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
              Change
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
                Remove
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
