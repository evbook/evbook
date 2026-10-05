import { useId } from "react";
import type { Bound } from "@shared/api-types";
import { cn } from "@/lib/utils";
import type { Range } from "@/lib/filters";

interface RangeSliderProps {
  label: string;
  bound: Bound;
  step: number;
  value: Range;
  onChange: (value: Range) => void;
  /** Renders the numeric readout, e.g. "12 km". */
  format: (value: number) => string;
}

/**
 * Dual-thumb range filter. Two overlaid range inputs give the drag feel, and the
 * readout shows exact figures. An empty min or max means "unbounded", so a
 * thumb parked at its extreme does not become a filter.
 */
export function RangeSlider({ label, bound, step, value, onChange, format }: RangeSliderProps) {
  const id = useId();
  // Snap the extents outwards to whole steps. Without this a range input cannot
  // land on its own maximum (min + n*step overshoots), so dragging the upper
  // thumb would silently exclude the largest values.
  const min = Math.floor(bound.min / step) * step;
  const max = Math.ceil(bound.max / step) * step;
  const usable = max > min;

  const low = value.min === "" ? min : Math.max(min, Number(value.min));
  const high = value.max === "" ? max : Math.min(max, Number(value.max));

  const pct = (n: number) => (usable ? ((n - min) / (max - min)) * 100 : 0);

  function setLow(next: number) {
    const clamped = Math.min(next, high);
    onChange({ ...value, min: clamped <= min ? "" : String(clamped) });
  }

  function setHigh(next: number) {
    const clamped = Math.max(next, low);
    onChange({ ...value, max: clamped >= max ? "" : String(clamped) });
  }

  const isFiltered = value.min !== "" || value.max !== "";

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-sm font-medium">
          {label}
        </label>
        <span className={cn("text-xs tabular-nums", isFiltered ? "text-foreground" : "text-muted-foreground")}>
          {usable ? `${format(low)} – ${format(high)}` : "no data"}
        </span>
      </div>

      <div className="relative h-5">
        {/* Track and the selected segment. */}
        <div className="absolute top-1/2 h-1.5 w-full -translate-y-1/2 rounded-full bg-muted" />
        <div
          className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-primary"
          style={{ left: `${pct(low)}%`, right: `${100 - pct(high)}%` }}
        />
        {/* Both inputs span the track; only their thumbs accept pointer events. */}
        <input
          id={id}
          type="range"
          aria-label={`${label} minimum`}
          min={min}
          max={max}
          step={step}
          value={low}
          disabled={!usable}
          onChange={(e) => setLow(Number(e.target.value))}
          className="evb-range absolute inset-0 w-full"
        />
        <input
          type="range"
          aria-label={`${label} maximum`}
          min={min}
          max={max}
          step={step}
          value={high}
          disabled={!usable}
          onChange={(e) => setHigh(Number(e.target.value))}
          className="evb-range absolute inset-0 w-full"
        />
      </div>
    </div>
  );
}
