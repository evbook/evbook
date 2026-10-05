import { useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router";
import { Plus } from "lucide-react";
import type { GeofenceDto, PlaceCategory, PlaceStatsDto } from "@shared/api-types";
import { api } from "@/lib/api";
import { DEFAULT_CURRENCY, type CurrencyCode } from "@shared/currency";
import { dateOnly, money, rate } from "@/lib/format";
import { GeofenceOverviewMap } from "@/components/GeofenceOverviewMap";
import { Place } from "@/components/Place";
import { StatTiles } from "@/components/StatTiles";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { SkeletonRows } from "@/components/TableSkeleton";
import { useAppSettings } from "@/hooks/useAppSettings";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PageHeader } from "@/components/PageHeader";

const CATEGORY_LABEL: Record<PlaceCategory, string> = {
  home: "Home",
  office: "Office",
  school: "School",
  university: "University",
  kindergarten: "Kindergarten",
  gym: "Gym",
  supermarket: "Supermarket",
  shopping: "Shopping",
  restaurant: "Restaurant",
  cafe: "Café",
  hospital: "Medical",
  charging: "Charging",
  hotel: "Hotel",
};

/** Places per request. The table appends, so this is a chunk size, not a page. */
const PLACES_PAGE = 10;

/** The new-geofence form, pre-filled with this place's spot and best-guess name. */
function addHref(place: {
  label: string;
  name?: string | null;
  category?: PlaceCategory | null;
  latitude: number | null;
  longitude: number | null;
}): string {
  const params = new URLSearchParams({ lat: String(place.latitude), lon: String(place.longitude) });
  const name = place.category === "home" ? "Home" : (place.name ?? place.label);
  if (name && name !== "Unknown") params.set("name", name);
  return `/geofences/new?${params.toString()}`;
}

/**
 * The quiet "already named" mark. Every table on this page cross-references the
 * geo-fence list through it, so it must read as an annotation, not as data.
 */
function FenceBadge({ name }: { name: string }) {
  return (
    <Badge variant="outline" className="px-1.5 py-0 align-middle text-[11px] font-normal text-muted-foreground">
      {name}
    </Badge>
  );
}

function costLabel(geofence: GeofenceDto, currency: CurrencyCode): string {
  const parts: string[] = [];
  if (geofence.costPerUnit != null) {
    // A tariff is stored in major units, unlike every other money column, so it
    // has to be put back into minor ones before the formatter sees it.
    const unit = geofence.billingType === "per_kwh" ? "kWh" : "min";
    parts.push(`${rate(geofence.costPerUnit * 100, currency)} per ${unit}`);
  }
  if (geofence.sessionFeeCents != null) parts.push(`${money(geofence.sessionFeeCents, currency)} fee`);
  return parts.length > 0 ? parts.join(" + ") : "–";
}

export function GeofencesPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [confirmId, setConfirmId] = useState<number | null>(null);
  // "Load more" grows the ask rather than paging: the ranking is one list, and a
  // bigger limit re-fetches it whole, so rows can never repeat or go missing.
  const [placesLimit, setPlacesLimit] = useState(PLACES_PAGE);

  const geofences = useQuery({
    queryKey: ["geofences"],
    queryFn: () => api<GeofenceDto[]>("/api/v1/geofences"),
  });
  // Lifetime, so no window and no car picker — this page has neither.
  const places = useQuery({
    queryKey: ["place-stats", placesLimit],
    queryFn: () => api<PlaceStatsDto>(`/api/v1/stats/places?limit=${placesLimit}`),
    // Loading more keeps the rows already shown instead of blanking the table.
    placeholderData: keepPreviousData,
  });
  const settings = useAppSettings();

  const remove = useMutation({
    mutationFn: (id: number) => api(`/api/v1/geofences/${id}`, { method: "DELETE" }),
    onSuccess: async () => {
      setConfirmId(null);
      await queryClient.invalidateQueries({ queryKey: ["geofences"] });
      // Deleting re-matches drives and charges, so their lists are stale too.
      await queryClient.invalidateQueries({ queryKey: ["drives"] });
      await queryClient.invalidateQueries({ queryKey: ["charges"] });
    },
  });

  /*
    The frame — headings, the New button, tiles, every table header — is drawn
    before any request answers, so the page opens at its final shape and only
    the rows fill in.
  */
  const rows = geofences.data ?? [];
  const timezone = settings.data?.timezone ?? "UTC";
  const currency = settings.data?.currency ?? DEFAULT_CURRENCY;

  const topPlaces = places.data?.topPlaces ?? [];
  // The call to action: places the tags leave little doubt about, not yet named.
  const suggestions = topPlaces
    .filter((p) => p.geofence === null && p.category !== null && p.latitude != null && p.longitude != null)
    .slice(0, 3);
  // Every possible row is one distinct address arrived at, so the count says
  // whether asking for more would return any. Both clauses matter: the second
  // stops the button once the server's own cap is what came back short.
  const morePlaces =
    places.data != null && topPlaces.length >= placesLimit && topPlaces.length < places.data.counts.addresses;
  const loadingMorePlaces = places.isFetching && !places.isLoading;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Geo-fences"
        description="Name the places you park and charge, and set what electricity costs there."
        actions={
          <Link
            to="/geofences/new"
            className="inline-flex h-9 items-center gap-2 rounded-full bg-primary px-4 text-sm font-medium text-primary-foreground shadow-button transition-colors hover:bg-primary/90 [&_svg]:size-4"
          >
            <Plus /> New geo-fence
          </Link>
        }
      />

      <Card>
        <CardContent className="p-0">
          {!geofences.isLoading && rows.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">
              No geo-fences yet. Create one for home or work and drives and charges there will be labelled
              automatically.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Position</TableHead>
                  <TableHead className="text-right">Radius</TableHead>
                  <TableHead>Cost</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {geofences.isLoading && <SkeletonRows columns={5} rows={3} />}
                {rows.map((geofence) => (
                  <TableRow key={geofence.id}>
                    <TableCell className="font-medium">{geofence.name}</TableCell>
                    <TableCell className="tabular-nums text-muted-foreground">
                      {geofence.latitude.toFixed(4)}, {geofence.longitude.toFixed(4)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{geofence.radius} m</TableCell>
                    <TableCell>{costLabel(geofence, currency)}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-3">
                        <Link to={`/geofences/${geofence.id}`} className="text-xs hover:underline">
                          Edit
                        </Link>
                        {confirmId === geofence.id ? (
                          <>
                            <button
                              className="text-xs text-destructive hover:underline"
                              onClick={() => remove.mutate(geofence.id)}
                            >
                              Confirm
                            </button>
                            <button
                              className="text-xs text-muted-foreground hover:underline"
                              onClick={() => setConfirmId(null)}
                            >
                              Cancel
                            </button>
                          </>
                        ) : (
                          <button
                            className="text-xs text-muted-foreground hover:underline"
                            onClick={() => setConfirmId(geofence.id)}
                          >
                            Delete
                          </button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Drawn while the list is still loading too — once any geo-fence exists
          this card is here to stay, so holding it back would drop everything
          below by its whole height. It only disappears when there are none. */}
      {(geofences.isLoading || rows.length > 0) && (
        <Card className="overflow-hidden">
          <CardHeader>
            <CardTitle className="text-base">Where they sit</CardTitle>
            <CardDescription>Every geo-fence at its true radius. Click a pin to edit it.</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {geofences.isLoading ? (
              <Skeleton className="h-80 w-full rounded-t-none" />
            ) : (
              <GeofenceOverviewMap
                geofences={rows}
                onSelect={(id) => void navigate(`/geofences/${id}`)}
                className="h-80 w-full"
              />
            )}
          </CardContent>
        </Card>
      )}

      <div>
        <h2 className="text-lg font-semibold tracking-tight">Everywhere the car has been</h2>
        <p className="text-sm text-muted-foreground">
          Out of the addresses the geocoder has resolved, counted by arrivals — places the car actually parked, not
          roads it drove down. A street you keep arriving at is one worth naming above.
        </p>
      </div>

      {/* "–" until the counts are in: a zero here is a claim about the history,
          not a way of saying the request has not answered yet. */}
      <StatTiles
        stats={[
          { label: "Addresses", value: places.data ? String(places.data.counts.addresses) : "–" },
          { label: "Cities", value: places.data ? String(places.data.counts.cities) : "–" },
          { label: "Regions", value: places.data ? String(places.data.counts.states) : "–" },
          { label: "Countries", value: places.data ? String(places.data.counts.countries) : "–" },
        ]}
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Most-visited places</CardTitle>
          <CardDescription>The addresses the car keeps coming back to. Add one straight from its row.</CardDescription>
        </CardHeader>
        {suggestions.length > 0 && (
          <div className="flex flex-wrap gap-2 px-6 pb-4">
            {suggestions.map((place) => (
              <Link
                key={`${place.label}-${place.lastAt}`}
                to={addHref(place)}
                title={`Add a geo-fence at ${place.label}${place.city ? `, ${place.city}` : ""}`}
                className="inline-flex items-center gap-1.5 rounded-md border border-dashed px-3 py-1.5 text-xs transition-colors hover:bg-accent [&_svg]:size-3.5"
              >
                <Plus />
                Add {CATEGORY_LABEL[place.category!]}
                <span className="text-muted-foreground">
                  · {place.category === "home" ? place.label : (place.name ?? place.label)}
                </span>
              </Link>
            ))}
          </div>
        )}
        <CardContent className="p-0">
          {!places.isLoading && topPlaces.length === 0 ? (
            <p className="px-6 pb-6 text-sm text-muted-foreground">
              Nothing geocoded yet. Places rank here once drives start arriving somewhere.
            </p>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Place</TableHead>
                    <TableHead className="text-right">Arrivals</TableHead>
                    <TableHead className="text-right">Last</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {places.isLoading && <SkeletonRows columns={4} />}
                  {topPlaces.map((place) => (
                    <TableRow key={`${place.label}-${place.lastAt}`}>
                      <TableCell className="max-w-64 truncate font-medium">
                        <Place
                          label={place.label}
                          region={place.city}
                          badge={
                            place.category !== null ? (
                              <Badge variant="secondary" className="px-1.5 py-0 align-middle text-[11px] font-normal">
                                {CATEGORY_LABEL[place.category]}?
                              </Badge>
                            ) : undefined
                          }
                        />
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{place.visits}</TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {dateOnly(place.lastAt, timezone)}
                      </TableCell>
                      <TableCell className="text-right">
                        {place.geofence !== null ? (
                          <FenceBadge name={place.geofence} />
                        ) : place.latitude != null && place.longitude != null ? (
                          <Link
                            to={addHref(place)}
                            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground hover:underline [&_svg]:size-3"
                          >
                            <Plus /> Add geo-fence
                          </Link>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {morePlaces && (
                <div className="flex items-center justify-between border-t px-6 py-3">
                  <span className="text-sm text-muted-foreground">
                    {topPlaces.length} of {places.data!.counts.addresses} places
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={loadingMorePlaces}
                    onClick={() => setPlacesLimit((limit) => limit + PLACES_PAGE)}
                  >
                    {loadingMorePlaces ? "Loading…" : "Load more"}
                  </Button>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Most-visited cities</CardTitle>
            <CardDescription>By arrivals.</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {!places.isLoading && (places.data?.topCities.length ?? 0) === 0 ? (
              <p className="px-6 pb-6 text-sm text-muted-foreground">
                No arrivals with a city yet. Addresses fill in as drives are geocoded.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>City</TableHead>
                    <TableHead className="text-right">Arrivals</TableHead>
                    <TableHead className="text-right">Last</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {places.isLoading && <SkeletonRows columns={3} />}
                  {(places.data?.topCities ?? []).map((city) => (
                    <TableRow key={city.label}>
                      <TableCell className="max-w-48 truncate font-medium">
                        {city.label}
                        {city.geofences.map((name) => (
                          <span key={name} className="ml-2">
                            <FenceBadge name={name} />
                          </span>
                        ))}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{city.visits}</TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {city.lastAt != null ? dateOnly(city.lastAt, timezone) : "–"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Where it has been lately</CardTitle>
            <CardDescription>The last twenty places it parked, newest first.</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {!places.isLoading && (places.data?.recent.length ?? 0) === 0 ? (
              <p className="px-6 pb-6 text-sm text-muted-foreground">Nothing geocoded yet.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Place</TableHead>
                    <TableHead className="text-right">Arrivals</TableHead>
                    <TableHead className="text-right">Last</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {places.isLoading && <SkeletonRows columns={4} />}
                  {(places.data?.recent ?? []).map((place) => (
                    <TableRow key={`${place.label}-${place.lastAt}`}>
                      <TableCell className="max-w-48 truncate font-medium">
                        <Place
                          label={place.label}
                          region={place.city}
                          badge={place.geofence !== null ? <FenceBadge name={place.geofence} /> : undefined}
                        />
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{place.visits}</TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {dateOnly(place.lastAt, timezone)}
                      </TableCell>
                      <TableCell className="text-right">
                        {place.geofence === null && place.latitude != null && place.longitude != null ? (
                          <Link
                            to={addHref(place)}
                            className="inline-flex items-center gap-1 whitespace-nowrap text-xs text-muted-foreground hover:text-foreground hover:underline [&_svg]:size-3"
                          >
                            <Plus /> Add geo-fence
                          </Link>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
