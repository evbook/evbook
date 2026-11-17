import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import type { SkodaCarDto } from "@shared/api-types";
import { api, ApiRequestError } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatDate } from "@/lib/datetime";

const KEYS_URL = "https://go.skoda.eu/api-keys";

/**
 * Connecting a Škoda: a VIN and the API key the owner created for that car in
 * the MySkoda app. One key per car, so each connected Škoda is listed with its
 * own key, which can be replaced when it lapses without losing the car's history.
 * The whole of `/connect/skoda`, on a first run and after.
 */
export function SkodaConnect({ timezone, onConnected }: { timezone: string; onConnected?: () => void }) {
  const queryClient = useQueryClient();
  const cars = useQuery({ queryKey: ["skoda"], queryFn: () => api<SkodaCarDto[]>("/api/v1/skoda") });
  const [vin, setVin] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["skoda"] });
    void queryClient.invalidateQueries({ queryKey: ["accounts"] });
    void queryClient.invalidateQueries({ queryKey: ["cars"] });
    void queryClient.invalidateQueries({ queryKey: ["session"] });
  };

  const connect = useMutation({
    mutationFn: () =>
      api<{ ok: true }>("/api/v1/skoda/cars", { method: "POST", body: JSON.stringify({ vin, apiKey }) }),
    onSuccess: () => {
      setVin("");
      setApiKey("");
      setError(null);
      setAdding(false);
      refresh();
      onConnected?.();
    },
    onError: (err) =>
      setError(err instanceof ApiRequestError && err.message ? err.message : "Škoda did not accept the key."),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    connect.mutate();
  };

  const list = cars.data ?? [];
  const showForm = adding || (cars.isSuccess && list.length === 0);

  return (
    <div className="space-y-5 text-sm">
      {list.length > 0 && (
        <ul className="divide-y rounded-xl border">
          {list.map((car) => (
            <SkodaCarRow key={car.account} car={car} timezone={timezone} onChanged={refresh} />
          ))}
        </ul>
      )}

      {showForm ? (
        <form onSubmit={submit} className="space-y-3">
          <ol className="list-decimal space-y-1.5 pl-5 text-muted-foreground">
            <li>
              In the MySkoda app (version 8.16 or later), open{" "}
              <span className="text-foreground">Profile → Smart Home</span>, or{" "}
              <a href={KEYS_URL} target="_blank" rel="noreferrer" className="underline underline-offset-4">
                go.skoda.eu/api-keys
              </a>{" "}
              on your phone.
            </li>
            <li>Create an API key for the car. Škoda shows it only once, so copy it straight away.</li>
            <li>Paste it here with the car&apos;s VIN. EVBook checks it with one read before storing it.</li>
          </ol>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="skoda-vin">VIN</Label>
              <Input
                id="skoda-vin"
                value={vin}
                maxLength={17}
                placeholder="TMB…"
                onChange={(e) => setVin(e.target.value.toUpperCase())}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="skoda-key">API key</Label>
              <Input
                id="skoda-key"
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Škoda&apos;s API is for personal use and allows 20 reads an hour per key. EVBook reads every 5 minutes while
            the car drives or charges and every 30 minutes while it is parked, and never sends it a command.
          </p>
          {error && <p className="text-destructive">{error}</p>}
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" size="sm" disabled={connect.isPending || vin.length !== 17 || !apiKey}>
              {connect.isPending ? "Asking Škoda…" : "Connect"}
            </Button>
            {list.length > 0 && (
              <Button type="button" variant="ghost" size="sm" onClick={() => setAdding(false)}>
                Cancel
              </Button>
            )}
          </div>
        </form>
      ) : (
        cars.isSuccess && (
          <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
            Add another Škoda
          </Button>
        )
      )}
      {cars.isError && <p className="text-destructive">Could not load the connected Škodas.</p>}
    </div>
  );
}

function SkodaCarRow({ car, timezone, onChanged }: { car: SkodaCarDto; timezone: string; onChanged: () => void }) {
  const [replacing, setReplacing] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);

  const replace = useMutation({
    mutationFn: () =>
      api(`/api/v1/skoda/cars/${encodeURIComponent(car.account)}/key`, {
        method: "PUT",
        body: JSON.stringify({ apiKey }),
      }),
    onSuccess: () => {
      setApiKey("");
      setError(null);
      setReplacing(false);
      onChanged();
    },
    onError: (err) =>
      setError(err instanceof ApiRequestError && err.message ? err.message : "Škoda did not accept the key."),
  });
  const remove = useMutation({
    mutationFn: () => api(`/api/v1/accounts/${encodeURIComponent(car.account)}`, { method: "DELETE" }),
    onSuccess: onChanged,
  });

  const badge = car.refusedReason
    ? { text: "Key refused", variant: "destructive" as const }
    : car.expiring
      ? { text: "Key expiring", variant: "secondary" as const }
      : { text: "Connected", variant: "success" as const };

  return (
    <li className="space-y-2 p-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{car.name ?? "Škoda"}</span>
        <Badge variant={badge.variant}>{badge.text}</Badge>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        <dt className="text-muted-foreground">VIN</dt>
        <dd className="truncate font-mono text-xs leading-5">{car.vin}</dd>
        <dt className="text-muted-foreground">API key</dt>
        <dd>
          …{car.keyLast4}
          {car.expiresAt !== null && <> · lapses {formatDate(car.expiresAt, "date", timezone)}</>}
        </dd>
      </dl>
      {car.lastError && <p className="text-destructive">{car.lastError}</p>}
      {replacing ? (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            replace.mutate();
          }}
        >
          <div className="min-w-48 flex-1 space-y-1.5">
            <Label htmlFor={`skoda-key-${car.account}`}>New API key</Label>
            <Input
              id={`skoda-key-${car.account}`}
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <Button type="submit" size="sm" disabled={replace.isPending || !apiKey}>
            {replace.isPending ? "Asking Škoda…" : "Save key"}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setReplacing(false)}>
            Cancel
          </Button>
        </form>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button
            variant={car.refusedReason || car.expiring ? "default" : "outline"}
            size="sm"
            onClick={() => setReplacing(true)}
          >
            Replace key
          </Button>
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
      )}
      {confirmRemove && (
        <p className="text-xs text-muted-foreground">
          The key is forgotten and the car stops being logged. Its history stays.
        </p>
      )}
      {error && <p className="text-destructive">{error}</p>}
    </li>
  );
}
