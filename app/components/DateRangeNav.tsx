import { useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { toDateInput } from "@/lib/format";
import {
  PRESETS,
  isAtPresent,
  periodOf,
  rangeLabel,
  selectedWindow,
  steppedFrom,
  type FilterPatch,
  type FilterState,
  type PresetKey,
  type RangeContext,
} from "@/lib/filters";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface DateRangeNavProps {
  state: FilterState;
  onChange: (patch: FilterPatch) => void;
  ctx: RangeContext;
  /**
   * Whether to offer all time. The timeline page leaves it out: a state band and a
   * downsampled series are both proportions of a bounded window, so an unbounded
   * one has nothing to be a proportion of.
   */
  allowAll?: boolean;
}

/**
 * Presets, arrows, and the resolved dates.
 *
 * The arrows are the point of it: a preset sets the size of a step and the arrows
 * walk the calendar in those steps, which is how you ask "what about last week"
 * without doing date arithmetic in your head. And the dates are always on screen,
 * because a preset alone never tells you which days you are actually looking at —
 * which matters most on a chart, where the axis is the whole answer.
 */
export function DateRangeNav({ state, onChange, ctx, allowAll = true }: DateRangeNavProps) {
  const stepping = periodOf(state.preset) != null;
  const atPresent = isAtPresent(state, ctx);
  // The period selected, not the part of it that has happened: the fields should
  // say "this week" ends on Sunday even while Sunday is still ahead.
  const window = selectedWindow(state, ctx);

  // Both inputs show the resolved window, whichever way it was arrived at, so
  // stepping with the arrows visibly moves the dates.
  const shownFrom =
    state.preset === "custom" ? state.from : window.from != null ? toDateInput(window.from, ctx.timeZone) : "";
  const shownTo =
    state.preset === "custom"
      ? state.to
      : // `to` is the next window's start, so the last day inside it is a moment earlier.
        window.to != null
        ? toDateInput(window.to - 1, ctx.timeZone)
        : "";

  const step = (direction: -1 | 1) => {
    if (!stepping || (direction === 1 && atPresent)) return;
    // Stepped from the window the URL holds now rather than the one this render
    // was drawn from, so a run of quick clicks walks one period per click instead
    // of losing the ones that land before the next render.
    onChange((current) =>
      direction === 1 && isAtPresent(current, ctx) ? {} : { from: steppedFrom(current, direction, ctx) },
    );
  };

  const pick = (key: PresetKey) =>
    onChange((current) =>
      // Re-picking the preset you are already on is the way back to the present,
      // which is also the only way back once you have stepped away.
      key === current.preset
        ? { from: key === "custom" ? current.from : "" }
        : // Switching preset always lands on the current window: a pinned start from
          // the old preset would resolve to an arbitrary window in the new one.
          { preset: key, from: "", to: "" },
    );

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-3">
      {/*
        One focus stop for the whole group, with the arrow keys stepping inside it.
        Left and right are what a person reaches for once they can see that the
        window moves, and it saves a trip to the mouse for every step.
      */}
      <div
        role="group"
        aria-label="Date range"
        onKeyDown={(e) => {
          if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
          // Not while a date field has focus — there the arrows edit the value.
          if (e.target instanceof HTMLInputElement) return;
          e.preventDefault();
          step(e.key === "ArrowLeft" ? -1 : 1);
        }}
        className="flex items-center gap-1.5"
      >
        {/* A segmented control: one well, and the chosen preset is the raised segment. */}
        <div className="flex flex-1 items-center gap-0.5 rounded-lg border bg-muted/60 p-0.5 sm:flex-none">
          {[...PRESETS, ...(allowAll ? [{ key: "all" as PresetKey, label: "ALL" }] : [])].map((preset) => (
            <button
              key={preset.key}
              onClick={() => pick(preset.key)}
              aria-pressed={state.preset === preset.key}
              className={cn(
                "flex-1 whitespace-nowrap rounded-md px-3 py-1.5 text-xs font-medium tabular-nums transition-[color,background-color,box-shadow] duration-150 sm:flex-none sm:py-1",
                state.preset === preset.key
                  ? "bg-card text-foreground shadow-card"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {preset.label}
            </button>
          ))}
        </div>

        {stepping && (
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="icon"
              className="size-8 rounded-full"
              onClick={() => step(-1)}
              aria-label={`Previous ${periodOf(state.preset)}`}
            >
              <ChevronLeft />
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="size-8 rounded-full"
              onClick={() => step(1)}
              // Nothing has happened yet in the window after this one, so stepping
              // into it would only ever show an empty page.
              disabled={atPresent}
              aria-label={`Next ${periodOf(state.preset)}`}
            >
              <ChevronRight />
            </Button>
          </div>
        )}
      </div>

      <RangeDates
        state={state}
        onChange={onChange}
        ctx={ctx}
        shownFrom={shownFrom}
        shownTo={shownTo}
        disabled={state.preset === "all"}
      />
    </div>
  );
}

/**
 * The two dates. Editing either one switches to a custom range, which is what
 * makes the fields worth having always visible rather than behind a "Custom"
 * preset: the range you are looking at is also the range you can adjust.
 *
 * Two native date inputs do not fit a phone alongside five presets and two arrows,
 * and going through an OS date wheel twice to nudge a range is miserable anyway.
 * So below `sm` this collapses to the range as text, which still answers "what am
 * I looking at", and opens the inputs on tap for the rarer case of typing one in.
 */
function RangeDates({
  state,
  onChange,
  ctx,
  shownFrom,
  shownTo,
  disabled,
}: {
  state: FilterState;
  onChange: (patch: FilterPatch) => void;
  ctx: RangeContext;
  shownFrom: string;
  shownTo: string;
  disabled: boolean;
}) {
  // Only ever expanded deliberately, and `disabled` collapses it in the render
  // below rather than through an effect, so there is no state to keep in step.
  const [open, setOpen] = useState(false);

  const edit = (patch: { from?: string; to?: string }) =>
    // Editing either end pins both, so the window stops following the calendar.
    onChange({ preset: "custom", from: patch.from ?? shownFrom, to: patch.to ?? shownTo });

  const fields = (
    <div className="flex items-center gap-2">
      <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">From</span>
      <Input
        type="date"
        aria-label="From"
        className="h-8 w-auto min-w-0 text-xs"
        value={shownFrom}
        disabled={disabled}
        onChange={(e) => edit({ from: e.target.value })}
      />
      <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">To</span>
      <Input
        type="date"
        aria-label="To"
        className="h-8 w-auto min-w-0 text-xs"
        value={shownTo}
        disabled={disabled}
        onChange={(e) => edit({ to: e.target.value })}
      />
    </div>
  );

  return (
    <>
      <div className="hidden sm:flex sm:items-center">{fields}</div>

      <div className="sm:hidden">
        {open && !disabled ? (
          fields
        ) : (
          <button
            onClick={() => !disabled && setOpen(true)}
            aria-label="Edit date range"
            className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:no-underline"
            disabled={disabled}
          >
            {rangeLabel(state, ctx)}
          </button>
        )}
      </div>
    </>
  );
}
