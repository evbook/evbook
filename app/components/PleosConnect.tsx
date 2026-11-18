import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import type { PleosAccountDto, PleosBrand, PleosConnectResult, PleosSkippedCarDto } from "@shared/api-types";
import { api, ApiRequestError } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Segmented } from "@/components/ui/segmented";

const KEY_GUIDE_URL =
  "https://document.pleos.ai/en/api-reference/vehicle-data-api/getting-started/for-private-users/request-my-vehicle-api-key";

const BRANDS: readonly { value: PleosBrand; label: string }[] = [
  { value: "hyundai", label: "Hyundai" },
  { value: "kia", label: "Kia" },
  { value: "genesis", label: "Genesis" },
];

const brandName = (brand: PleosBrand) => BRANDS.find((b) => b.value === brand)?.label ?? brand;

const failed = (err: unknown) =>
  err instanceof ApiRequestError && err.message ? err.message : "Pleos did not accept the key.";

/** The cars a key covers that EVBook leaves out, in words. */
function skippedLine(skipped: PleosSkippedCarDto[]): string | null {
  if (skipped.length === 0) return null;
  const names = skipped.map((car) => car.model ?? "a car").join(", ");
  return `Not logged, since ${skipped.length === 1 ? "it is" : "they are"} not electric: ${names}.`;
}

/**
 * Connecting a Hyundai, Kia or Genesis: the make, and the client ID and secret
 * of the personal key the owner issued in Pleos Playground. One key per make
 * covers all of that owner's cars, so each key is listed with its cars, and
 * can be replaced (reissued, or to take in a car added since) without losing
 * any car's history. The whole of `/connect/pleos`, on a first run and after.
 */
export function PleosConnect({ onConnected }: { onConnected?: () => void }) {
  const queryClient = useQueryClient();
  const accounts = useQuery({ queryKey: ["pleos"], queryFn: () => api<PleosAccountDto[]>("/api/v1/pleos") });
  const [brand, setBrand] = useState<PleosBrand>("hyundai");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["pleos"] });
    void queryClient.invalidateQueries({ queryKey: ["accounts"] });
    void queryClient.invalidateQueries({ queryKey: ["cars"] });
    void queryClient.invalidateQueries({ queryKey: ["session"] });
  };

  const connect = useMutation({
    mutationFn: () =>
      api<PleosConnectResult>("/api/v1/pleos/keys", {
        method: "POST",
        body: JSON.stringify({ brand, clientId, clientSecret }),
      }),
    onSuccess: (result) => {
      setClientId("");
      setClientSecret("");
      setError(null);
      setNotice(skippedLine(result.skipped));
      setAdding(false);
      refresh();
      onConnected?.();
    },
    onError: (err) => setError(failed(err)),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    connect.mutate();
  };

  const list = accounts.data ?? [];
  const showForm = adding || (accounts.isSuccess && list.length === 0);

  return (
    <div className="space-y-5 text-sm">
      {list.length > 0 && (
        <ul className="divide-y rounded-xl border">
          {list.map((account) => (
            <PleosKeyRow key={account.account} account={account} onChanged={refresh} />
          ))}
        </ul>
      )}
      {notice && <p className="text-muted-foreground">{notice}</p>}

      {showForm ? (
        <form onSubmit={submit} className="space-y-3">
          <ol className="list-decimal space-y-1.5 pl-5 text-muted-foreground">
            <li>
              Sign in to <span className="text-foreground">Pleos Playground</span> and open{" "}
              <span className="text-foreground">Workspace → My Vehicle Data API</span> (
              <a href={KEY_GUIDE_URL} target="_blank" rel="noreferrer" className="underline underline-offset-4">
                Pleos&apos;s guide
              </a>
              ).
            </li>
            <li>
              Choose the make and sign in with your Hyundai, Kia or Genesis account. You must be the car&apos;s primary
              user.
            </li>
            <li>Copy the Client ID and the Client Secret here. EVBook checks them with Pleos before storing them.</li>
          </ol>
          <div className="space-y-1.5">
            <span className="text-sm font-medium">Make</span>
            <div>
              <Segmented label="Make" size="md" value={brand} options={BRANDS} onChange={setBrand} />
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="pleos-client-id">Client ID</Label>
              <Input
                id="pleos-client-id"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pleos-client-secret">Client Secret</Label>
              <Input
                id="pleos-client-secret"
                type="password"
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground text-pretty">
            Europe only, for now. Pleos gives a key one live token at a time, so give EVBook a key no other program
            (Home Assistant, evcc) uses, or both will keep failing. EVBook reads what the car last sent, never wakes it
            and never sends it a command. Pleos reports no charging power, so the energy of a charge is not known.
          </p>
          {error && <p className="text-destructive">{error}</p>}
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" size="sm" disabled={connect.isPending || !clientId.trim() || !clientSecret.trim()}>
              {connect.isPending ? "Asking Pleos…" : "Connect"}
            </Button>
            {list.length > 0 && (
              <Button type="button" variant="ghost" size="sm" onClick={() => setAdding(false)}>
                Cancel
              </Button>
            )}
          </div>
        </form>
      ) : (
        accounts.isSuccess && (
          <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
            Add a key for another make
          </Button>
        )
      )}
      {accounts.isError && <p className="text-destructive">Could not load the connected Pleos keys.</p>}
    </div>
  );
}

function PleosKeyRow({ account, onChanged }: { account: PleosAccountDto; onChanged: () => void }) {
  const [replacing, setReplacing] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const replace = useMutation({
    mutationFn: () =>
      api<PleosConnectResult>(`/api/v1/pleos/keys/${encodeURIComponent(account.account)}`, {
        method: "PUT",
        body: JSON.stringify({ clientId, clientSecret }),
      }),
    onSuccess: (result) => {
      setClientId("");
      setClientSecret("");
      setError(null);
      setNotice(skippedLine(result.skipped));
      setReplacing(false);
      onChanged();
    },
    onError: (err) => setError(failed(err)),
  });
  const remove = useMutation({
    mutationFn: () => api(`/api/v1/accounts/${encodeURIComponent(account.account)}`, { method: "DELETE" }),
    onSuccess: onChanged,
  });

  const badge = account.refusedReason
    ? { text: "Key refused", variant: "destructive" as const }
    : { text: "Connected", variant: "success" as const };
  const id = account.account;

  return (
    <li className="space-y-2 p-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{brandName(account.brand)}</span>
        <Badge variant={badge.variant}>{badge.text}</Badge>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        <dt className="text-muted-foreground">Client ID</dt>
        <dd className="truncate font-mono text-xs leading-5">{account.clientId}</dd>
        <dt className="text-muted-foreground">Secret</dt>
        <dd>…{account.secretLast4}</dd>
        <dt className="text-muted-foreground">Cars</dt>
        <dd className="min-w-0">
          {account.cars.length === 0
            ? "None"
            : account.cars.map((car) => (
                <span key={car.vin} className="block truncate">
                  {car.name ?? brandName(account.brand)} <span className="font-mono text-xs">{car.vin}</span>
                </span>
              ))}
        </dd>
      </dl>
      {account.lastError && <p className="text-destructive">{account.lastError}</p>}
      {notice && <p className="text-muted-foreground">{notice}</p>}
      {replacing ? (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            replace.mutate();
          }}
        >
          <p className="text-xs text-muted-foreground text-pretty">
            A key covers the cars on your account when it was issued. Reissue it in Pleos Playground after adding a car,
            then paste the new one here.
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor={`pleos-id-${id}`}>New Client ID</Label>
              <Input
                id={`pleos-id-${id}`}
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`pleos-secret-${id}`}>New Client Secret</Label>
              <Input
                id={`pleos-secret-${id}`}
                type="password"
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" disabled={replace.isPending || !clientId.trim() || !clientSecret.trim()}>
              {replace.isPending ? "Asking Pleos…" : "Save key"}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setReplacing(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button variant={account.refusedReason ? "default" : "outline"} size="sm" onClick={() => setReplacing(true)}>
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
          The key is forgotten and its cars stop being logged. Their history stays.
        </p>
      )}
      {error && <p className="text-destructive">{error}</p>}
    </li>
  );
}
