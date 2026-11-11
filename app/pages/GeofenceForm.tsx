import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { ArrowLeft } from "lucide-react";
import type { CarSummaryDto, GeofenceDto } from "@shared/api-types";
import { DEFAULT_CURRENCY } from "@shared/currency";
import { DEFAULT_AC_EFFICIENCY, DEFAULT_DC_EFFICIENCY } from "../../src/core/derive/cost";
import { localDate } from "../../src/core/zone";
import { blankPrice, fromDrafts, toDraft, type PriceDraft } from "@/lib/tariff";
import { TariffEditor } from "@/components/TariffEditor";
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
  /** "" — the account's zone. */
  timezone: string;
  chargerPowerKw: string;
  /** Percent, as typed. */
  acEfficiency: string;
  dcEfficiency: string;
  prices: PriceDraft[];
}

function blankForm(today: string): FormState {
  return {
    name: "",
    latitude: 0,
    longitude: 0,
    radius: 60,
    timezone: "",
    chargerPowerKw: "",
    acEfficiency: "",
    dcEfficiency: "",
    prices: [blankPrice(today)],
  };
}

/** Every zone the browser knows, for the time zone picker. */
const ZONES: string[] = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];

function optionalNumber(text: string, scale = 1): number | null | "invalid" {
  const trimmed = text.trim().replace(",", ".");
  if (trimmed === "") return null;
  const value = Number(trimmed);
  return Number.isFinite(value) && value > 0 ? value * scale : "invalid";
}

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

  const settings = useAppSettings();
  const currency = settings.data?.currency ?? DEFAULT_CURRENCY;
  const accountZone = settings.data?.timezone ?? "UTC";

  // The moment the form opened: "today" for a new price, read once so a render never moves it.
  const [openedAt] = useState(() => Date.now());
  const [form, setForm] = useState<FormState>(() => blankForm(localDate(openedAt, accountZone)));
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const existing = useQuery({
    queryKey: ["geofence", id],
    queryFn: () => api<GeofenceDto>(`/api/v1/geofences/${id}`),
    enabled: !isNew,
  });

  // A new geofence starts at the car's last known position, which is almost
  // always where the user is standing when they create one.
  const summaries = useQuery({
    queryKey: ["summaries"],
    queryFn: () => api<CarSummaryDto[]>("/api/v1/summaries"),
    enabled: isNew && !hasPrefill,
  });

  const zone = form.timezone || accountZone;
  const today = localDate(openedAt, zone);

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
      const match = existing.data;
      if (match) {
        const placeZone = match.timezone ?? accountZone;
        setForm({
          name: match.name,
          latitude: match.latitude,
          longitude: match.longitude,
          radius: match.radius,
          timezone: match.timezone ?? "",
          chargerPowerKw: match.chargerPowerKw != null ? String(match.chargerPowerKw) : "",
          acEfficiency: match.acEfficiency != null ? String(Math.round(match.acEfficiency * 1000) / 10) : "",
          dcEfficiency: match.dcEfficiency != null ? String(Math.round(match.dcEfficiency * 1000) / 10) : "",
          prices: match.tariff.length > 0 ? match.tariff.map(toDraft) : [blankPrice(localDate(openedAt, placeZone))],
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
    accountZone,
    openedAt,
    summaries.isSuccess,
    summaries.data,
    hasPrefill,
    prefillLat,
    prefillLon,
    searchParams,
  ]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const save = useMutation({
    mutationFn: async (body: Record<string, unknown>) => {
      const result = isNew
        ? await api<{ id: number }>("/api/v1/geofences", { method: "POST", body: JSON.stringify(body) })
        : await api<{ id: number }>(`/api/v1/geofences/${id}`, { method: "PUT", body: JSON.stringify(body) });
      return result.id;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["geofences"] });
      await queryClient.invalidateQueries({ queryKey: ["geofence"] });
      await queryClient.invalidateQueries({ queryKey: ["drives"] });
      // A tariff change reprices sessions, which every charge view shows.
      await queryClient.invalidateQueries({ queryKey: ["charges"] });
      await queryClient.invalidateQueries({ queryKey: ["charge"] });
      navigate("/geofences");
    },
    onError: () => setError("Could not save this geo-fence. Check the name, radius and prices."),
  });

  if (!ready) return <Skeleton className="h-96" />;

  function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (form.name.trim() === "") {
      setError("Give this place a name.");
      return;
    }
    const tariff = fromDrafts(form.prices);
    if ("error" in tariff) {
      setError(tariff.error);
      return;
    }
    const chargerPowerKw = optionalNumber(form.chargerPowerKw);
    const acEfficiency = optionalNumber(form.acEfficiency, 0.01);
    const dcEfficiency = optionalNumber(form.dcEfficiency, 0.01);
    if (chargerPowerKw === "invalid") {
      setError("Charger power is in kW, like 11.");
      return;
    }
    for (const value of [acEfficiency, dcEfficiency]) {
      if (value === "invalid" || (value != null && (value < 0.5 || value > 1))) {
        setError("Efficiency is a percentage between 50 and 100.");
        return;
      }
    }
    save.mutate({
      name: form.name.trim(),
      latitude: form.latitude,
      longitude: form.longitude,
      radius: form.radius,
      timezone: form.timezone || null,
      chargerPowerKw,
      acEfficiency,
      dcEfficiency,
      tariff: tariff.tariff,
    });
  }

  // Sessions here older than the tariff's first day have no price. Offer to
  // start it on the day of the first one — the owner's call, not a default:
  // the price may well have been different back then.
  const place = existing.data;
  const firstDay = [...form.prices].map((p) => p.validFrom).sort()[0];
  const unpricedBefore =
    place?.firstChargeDate != null && firstDay != null && place.firstChargeDate < firstDay
      ? place.firstChargeDate
      : null;

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
            <CardDescription>
              Optional. With a price, sessions here get a cost automatically — by the hour, if the price has time
              windows. Days and hours are {form.timezone ? form.timezone : `the account's (${accountZone})`}.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            {unpricedBefore && (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed bg-muted/40 p-3 text-sm">
                <p>
                  {place && place.chargesBeforeTariff > 0 && firstDay === place.tariff[0]?.validFrom
                    ? `${place.chargesBeforeTariff} earlier ${place.chargesBeforeTariff === 1 ? "session" : "sessions"} here, back to ${unpricedBefore}, ${place.chargesBeforeTariff === 1 ? "has" : "have"} no price: the tariff starts later.`
                    : `Sessions here go back to ${unpricedBefore}, before this tariff's first day, and have no price.`}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setForm((f) => {
                      const prices = [...f.prices].sort((a, b) => (a.validFrom < b.validFrom ? -1 : 1));
                      prices[0] = { ...prices[0]!, validFrom: unpricedBefore };
                      return { ...f, prices };
                    })
                  }
                >
                  Start it on {unpricedBefore}
                </Button>
              </div>
            )}
            <TariffEditor
              prices={form.prices}
              onChange={(prices) => setForm((f) => ({ ...f, prices }))}
              currency={currency}
              today={today}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Charger</CardTitle>
            <CardDescription>
              Optional. What the grid delivers is more than the battery takes in; where the car does not report it,
              billed energy is estimated from these. The charger's power bounds how much any hour can take, which
              narrows a cost range.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-4">
            <div className="space-y-1.5">
              <Label htmlFor="charger-power">Charger power (kW)</Label>
              <Input
                id="charger-power"
                inputMode="decimal"
                placeholder="11"
                value={form.chargerPowerKw}
                onChange={(e) => setForm({ ...form, chargerPowerKw: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ac-efficiency">AC efficiency (%)</Label>
              <Input
                id="ac-efficiency"
                inputMode="decimal"
                placeholder={String(DEFAULT_AC_EFFICIENCY * 100)}
                value={form.acEfficiency}
                onChange={(e) => setForm({ ...form, acEfficiency: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="dc-efficiency">DC efficiency (%)</Label>
              <Input
                id="dc-efficiency"
                inputMode="decimal"
                placeholder={String(DEFAULT_DC_EFFICIENCY * 100)}
                value={form.dcEfficiency}
                onChange={(e) => setForm({ ...form, dcEfficiency: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="timezone">Time zone</Label>
              <Select
                id="timezone"
                value={form.timezone}
                onChange={(e) => setForm({ ...form, timezone: e.target.value })}
              >
                <option value="">Account's ({accountZone})</option>
                {ZONES.map((z) => (
                  <option key={z} value={z}>
                    {z}
                  </option>
                ))}
              </Select>
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
