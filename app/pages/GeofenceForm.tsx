import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { ArrowLeft } from "lucide-react";
import type { CarSummaryDto, GeofenceDto } from "@shared/api-types";
import { DEFAULT_CURRENCY } from "@shared/currency";
import { api } from "@/lib/api";
import { useAppSettings } from "@/hooks/useAppSettings";
import { GeofenceMap } from "@/components/GeofenceMap";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";

interface FormState {
  name: string;
  latitude: number;
  longitude: number;
  radius: number;
  billingType: "per_kwh" | "per_minute";
  costPerUnit: string;
  sessionFee: string;
}

const BLANK: FormState = {
  name: "",
  latitude: 0,
  longitude: 0,
  radius: 60,
  billingType: "per_kwh",
  costPerUnit: "",
  sessionFee: "",
};

export function GeofenceFormPage() {
  const { id } = useParams();
  const isNew = id === undefined || id === "new";
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // The places page links here with a spot already chosen — "add a geo-fence for
  // this address you keep visiting" — so the pin must land there, not on the car.
  const [searchParams] = useSearchParams();
  const prefillLat = Number(searchParams.get("lat"));
  const prefillLon = Number(searchParams.get("lon"));
  const hasPrefill = isNew && Number.isFinite(prefillLat) && Number.isFinite(prefillLon) && searchParams.has("lat");

  const [form, setForm] = useState<FormState>(BLANK);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uncosted, setUncosted] = useState<number | null>(null);

  const existing = useQuery({
    queryKey: ["geofences"],
    queryFn: () => api<GeofenceDto[]>("/api/v1/geofences"),
  });
  const currency = useAppSettings().data?.currency ?? DEFAULT_CURRENCY;

  // A new geofence starts at the car's last known position, which is almost
  // always where the user is standing when they create one.
  const summaries = useQuery({
    queryKey: ["summaries"],
    queryFn: () => api<CarSummaryDto[]>("/api/v1/summaries"),
    enabled: isNew && !hasPrefill,
  });

  /*
    Seeding the form from fetched data, once. The rule is right that this is an
    effect writing state React could own outright — the fix is to hold the form
    back until the geofence (or the car position) has arrived and seed it from the
    initial value, so there is no second render pass and no `ready` flag. That is a
    restructure of a page with a write path behind it, so it is left for its own
    change rather than folded into adding the linter.
  */
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (ready) return;
    if (!isNew) {
      const match = existing.data?.find((g) => String(g.id) === id);
      if (match) {
        setForm({
          name: match.name,
          latitude: match.latitude,
          longitude: match.longitude,
          radius: match.radius,
          billingType: match.billingType,
          costPerUnit: match.costPerUnit != null ? String(match.costPerUnit) : "",
          sessionFee: match.sessionFeeCents != null ? (match.sessionFeeCents / 100).toFixed(2) : "",
        });
        setReady(true);
      }
      return;
    }
    if (hasPrefill) {
      setForm((current) => ({
        ...current,
        name: searchParams.get("name") ?? current.name,
        latitude: prefillLat,
        longitude: prefillLon,
      }));
      setReady(true);
      return;
    }
    if (summaries.isSuccess) {
      const located = summaries.data.find((s) => s.latitude != null && s.longitude != null);
      setForm((current) => ({
        ...current,
        latitude: located?.latitude ?? 52.52,
        longitude: located?.longitude ?? 13.405,
      }));
      setReady(true);
    }
  }, [
    ready,
    isNew,
    id,
    existing.data,
    summaries.isSuccess,
    summaries.data,
    hasPrefill,
    prefillLat,
    prefillLon,
    searchParams,
  ]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        name: form.name.trim(),
        latitude: form.latitude,
        longitude: form.longitude,
        radius: form.radius,
        billingType: form.billingType,
        costPerUnit: form.costPerUnit.trim() === "" ? null : Number(form.costPerUnit),
        sessionFeeCents: form.sessionFee.trim() === "" ? null : Math.round(Number(form.sessionFee) * 100),
      };
      const result = isNew
        ? await api<{ id: number }>("/api/v1/geofences", { method: "POST", body: JSON.stringify(body) })
        : await api<{ id: number }>(`/api/v1/geofences/${id}`, { method: "PUT", body: JSON.stringify(body) });
      return result.id;
    },
    onSuccess: async (savedId) => {
      await queryClient.invalidateQueries({ queryKey: ["geofences"] });
      await queryClient.invalidateQueries({ queryKey: ["drives"] });
      await queryClient.invalidateQueries({ queryKey: ["charges"] });
      // Offer to backfill costs if sessions here have none yet.
      const hasCostRule = form.costPerUnit.trim() !== "" || form.sessionFee.trim() !== "";
      if (hasCostRule && savedId) {
        const result = await api<{ count: number }>(`/api/v1/geofences/${savedId}/uncosted`);
        if (result.count > 0) {
          setUncosted(result.count);
          return;
        }
      }
      navigate("/geofences");
    },
    onError: () => setError("Could not save this geo-fence. Check the name and radius."),
  });

  const applyCosts = useMutation({
    mutationFn: () => api(`/api/v1/geofences/${id ?? ""}/apply-costs`, { method: "POST" }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["charges"] });
      navigate("/geofences");
    },
  });

  if (!ready) return <Skeleton className="h-96" />;

  function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (form.name.trim() === "") {
      setError("Give this place a name.");
      return;
    }
    save.mutate();
  }

  if (uncosted !== null) {
    return (
      <Card className="mx-auto max-w-lg">
        <CardHeader>
          <CardTitle>Apply this cost retroactively?</CardTitle>
          <CardDescription>
            {uncosted} charging {uncosted === 1 ? "session" : "sessions"} at this location{" "}
            {uncosted === 1 ? "has" : "have"} no cost recorded. Apply the rule you just saved to{" "}
            {uncosted === 1 ? "it" : "them"}?
          </CardDescription>
        </CardHeader>
        <CardContent className="flex gap-2">
          <Button disabled={applyCosts.isPending} onClick={() => applyCosts.mutate()}>
            {applyCosts.isPending ? "Applying…" : "Apply to past sessions"}
          </Button>
          <Button variant="outline" onClick={() => navigate("/geofences")}>
            Skip
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <Link
          to="/geofences"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-4" /> Geo-fences
        </Link>
        <h1 className="mt-1.5 font-display text-[1.75rem] font-semibold leading-tight tracking-[-0.02em] text-balance sm:text-3xl">
          {isNew ? "New geo-fence" : "Edit geo-fence"}
        </h1>
      </div>

      <Card className="overflow-hidden">
        <GeofenceMap
          latitude={form.latitude}
          longitude={form.longitude}
          radius={form.radius}
          onMove={(latitude, longitude) => setForm((f) => ({ ...f, latitude, longitude }))}
          className="h-80 w-full"
        />
        <CardContent className="pt-6">
          <p className="text-xs text-muted-foreground">
            Drag the pin or click the map to move the centre. The circle shows the radius.
          </p>
        </CardContent>
      </Card>

      <form onSubmit={submit} className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Place</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="Home"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="radius">Radius (metres)</Label>
              <Input
                id="radius"
                type="number"
                min={1}
                max={4999}
                value={form.radius}
                onChange={(e) => setForm({ ...form, radius: Number(e.target.value) || 1 })}
              />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Charging cost</CardTitle>
            <CardDescription>Optional. When set, sessions at this place get a cost automatically.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="billing">Billed</Label>
              <Select
                id="billing"
                value={form.billingType}
                onChange={(e) => setForm({ ...form, billingType: e.target.value as FormState["billingType"] })}
              >
                <option value="per_kwh">Per kWh</option>
                <option value="per_minute">Per minute</option>
              </Select>
            </div>
            <div className="space-y-1.5">
              {/* Both figures are typed as bare numbers; the account's currency is
                  what they are in, so the label is where it has to be said. */}
              <Label htmlFor="rate">Rate ({currency})</Label>
              <Input
                id="rate"
                inputMode="decimal"
                placeholder="0.30"
                value={form.costPerUnit}
                onChange={(e) => setForm({ ...form, costPerUnit: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="fee">Session fee ({currency})</Label>
              <Input
                id="fee"
                inputMode="decimal"
                placeholder="0.00"
                value={form.sessionFee}
                onChange={(e) => setForm({ ...form, sessionFee: e.target.value })}
              />
            </div>
          </CardContent>
        </Card>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <div className="flex gap-2">
          <Button type="submit" disabled={save.isPending}>
            {save.isPending ? "Saving…" : "Save geo-fence"}
          </Button>
          <Button type="button" variant="outline" onClick={() => navigate("/geofences")}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}
