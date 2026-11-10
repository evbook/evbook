import { useState } from "react";
import { ChevronDown, Search, SlidersHorizontal, X } from "lucide-react";
import type { Bound, CarDto } from "@shared/api-types";
import { cn } from "@/lib/utils";
import {
  EMPTY_RANGE,
  emptyFilters,
  hasActiveFilters,
  stepFor,
  type FilterPatch,
  type FilterState,
  type LocationKey,
  type RangeContext,
} from "@/lib/filters";
import { useGeofences } from "@/hooks/useAppSettings";
import { DateRangeNav } from "@/components/DateRangeNav";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RangeSlider } from "@/components/ui/range-slider";
import { Select } from "@/components/ui/select";

export interface RangeConfig {
  key: string;
  label: string;
  bound: Bound;
  format: (value: number) => string;
}

/** Which end of the journey a place picker constrains — "From", "To", "Location". */
interface LocationConfig {
  key: LocationKey;
  label: string;
}

interface FilterPanelProps {
  cars: CarDto[];
  state: FilterState;
  onChange: (patch: FilterPatch) => void;
  ranges: RangeConfig[];
  defaultSort: string;
  ctx: RangeContext;
  /** Extra single-select filter, e.g. AC/DC on charges. */
  choice?: { label: string; options: { value: string; label: string }[] };
  /** Place pickers to offer: both ends on drives, the one place on charges. */
  locations?: LocationConfig[];
}

export function FilterPanel({
  cars,
  state,
  onChange,
  ranges,
  defaultSort,
  ctx,
  choice,
  locations = [],
}: FilterPanelProps) {
  const geofences = useGeofences();
  const places = geofences.data ?? [];
  const [expanded, setExpanded] = useState(
    () =>
      Object.values(state.ranges).some((r) => r.min !== "" || r.max !== "") ||
      // A link that arrives with a place already picked opens showing which one,
      // rather than a count of drives with nothing on screen to explain it.
      locations.some((location) => state[location.key] !== ""),
  );

  // Any filter change resets to the first page; the old page may not exist.
  const set = (patch: FilterPatch) =>
    onChange((current) => ({ ...(typeof patch === "function" ? patch(current) : patch), page: 0 }));
  const rangeKeys = ranges.map((r) => r.key);
  const active = hasActiveFilters(state);

  const chips: { key: string; label: string; clear: () => void }[] = [];
  if (state.carId) {
    const car = cars.find((c) => String(c.id) === state.carId);
    chips.push({
      key: "car",
      label: car?.name ?? `Car ${state.carId}`,
      clear: () => set({ carId: "" }),
    });
  }
  // No chip for the date range: it has its own always-visible control now, and a
  // chip repeating it was the one that most often looked like a second filter.
  if (state.search) {
    chips.push({ key: "search", label: `“${state.search}”`, clear: () => set({ search: "" }) });
  }
  if (state.currentType && choice) {
    const option = choice.options.find((o) => o.value === state.currentType);
    chips.push({ key: "type", label: option?.label ?? state.currentType, clear: () => set({ currentType: "" }) });
  }
  for (const location of locations) {
    const picked = state[location.key];
    if (!picked) continue;
    // Named even if the place has since been deleted, so the chip that clears the
    // filter is still there to explain why nothing matches.
    const place = places.find((p) => String(p.id) === picked);
    chips.push({
      key: location.key,
      label: `${location.label} ${place?.name ?? `place ${picked}`}`,
      clear: () => set({ [location.key]: "" }),
    });
  }
  for (const range of ranges) {
    const value = state.ranges[range.key];
    if (!value || (value.min === "" && value.max === "")) continue;
    const low = value.min === "" ? "min" : range.format(Number(value.min));
    const high = value.max === "" ? "max" : range.format(Number(value.max));
    chips.push({
      key: range.key,
      label: `${range.label} ${low} – ${high}`,
      clear: () => set((current) => ({ ranges: { ...current.ranges, [range.key]: { ...EMPTY_RANGE } } })),
    });
  }

  return (
    <div className="space-y-3">
      {/*
        The range on its own row: the presets, the arrows and both dates are one
        control and wrapping them apart from each other reads as two unrelated
        things. Search and Filters follow underneath below lg, inline above it.
      */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        <DateRangeNav state={state} onChange={set} ctx={ctx} />

        <div className="flex items-center gap-2 lg:ml-auto">
          <div className="relative flex-1 lg:flex-none">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="w-full pl-8 lg:w-48"
              placeholder="Search locations"
              value={state.search}
              onChange={(e) => set({ search: e.target.value })}
            />
          </div>
          <Button variant="outline" size="sm" onClick={() => setExpanded((e) => !e)} aria-expanded={expanded}>
            <SlidersHorizontal /> Filters
            <ChevronDown className={cn("transition-transform", expanded && "rotate-180")} />
          </Button>
        </div>
      </div>

      {expanded && (
        <div className="grid gap-5 rounded-xl border bg-card p-5 shadow-card sm:grid-cols-2 lg:grid-cols-3">
          {cars.length > 1 && (
            <div className="space-y-1.5">
              <Label htmlFor="f-car">Car</Label>
              <Select id="f-car" value={state.carId} onChange={(e) => set({ carId: e.target.value })}>
                <option value="">All cars</option>
                {cars.map((car) => (
                  <option key={car.id} value={car.id}>
                    {car.name ?? `VIN …${car.vin.slice(-6)}`}
                  </option>
                ))}
              </Select>
            </div>
          )}
          {/* Only where there is something to pick: a log with no named places
              would otherwise show a control whose one option is "Anywhere". */}
          {places.length > 0 &&
            locations.map((location) => (
              <div key={location.key} className="space-y-1.5">
                <Label htmlFor={`f-${location.key}`}>{location.label}</Label>
                <Select
                  id={`f-${location.key}`}
                  value={state[location.key]}
                  onChange={(e) => set({ [location.key]: e.target.value })}
                >
                  <option value="">Anywhere</option>
                  {places.map((place) => (
                    <option key={place.id} value={place.id}>
                      {place.name}
                    </option>
                  ))}
                </Select>
              </div>
            ))}
          {choice && (
            <div className="space-y-1.5">
              <Label htmlFor="f-choice">{choice.label}</Label>
              <Select id="f-choice" value={state.currentType} onChange={(e) => set({ currentType: e.target.value })}>
                {choice.options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </div>
          )}
          {ranges.map((range) => (
            <RangeSlider
              key={range.key}
              label={range.label}
              bound={range.bound}
              step={stepFor(range.bound)}
              value={state.ranges[range.key] ?? EMPTY_RANGE}
              format={range.format}
              onChange={(value) => set((current) => ({ ranges: { ...current.ranges, [range.key]: value } }))}
            />
          ))}
        </div>
      )}

      {chips.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {chips.map((chip) => (
            <Badge key={chip.key} variant="secondary" className="gap-1 py-1 pl-2 pr-1">
              {chip.label}
              <button
                onClick={chip.clear}
                aria-label={`Remove ${chip.label} filter`}
                className="rounded p-0.5 hover:bg-background/60"
              >
                <X className="size-3" />
              </button>
            </Badge>
          ))}
          {active && (
            <button
              onClick={() => onChange(emptyFilters(defaultSort, rangeKeys))}
              className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              Clear all
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Column header that toggles sort direction, cycling desc → asc. */
export function SortHeader({
  label,
  column,
  state,
  onChange,
  align = "left",
}: {
  label: string;
  column: string;
  state: FilterState;
  onChange: (patch: FilterPatch) => void;
  align?: "left" | "right";
}) {
  const isActive = state.sort === column;
  return (
    <button
      // The direction comes from the sort in force at the click, not the one this
      // header was drawn with, so a double click ends up ascending rather than back
      // where it started.
      onClick={() =>
        onChange((current) => ({
          sort: column,
          dir: current.sort === column && current.dir === "desc" ? "asc" : "desc",
          page: 0,
        }))
      }
      className={cn(
        "inline-flex items-center gap-1 transition-colors hover:text-foreground",
        isActive && "font-medium text-foreground",
        align === "right" && "flex-row-reverse",
      )}
    >
      {label}
      <span aria-hidden className={cn("text-[10px]", !isActive && "opacity-0")}>
        {state.dir === "desc" ? "▼" : "▲"}
      </span>
    </button>
  );
}
