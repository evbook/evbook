import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { CurrencyCode } from "@shared/currency";
import { BASE, weekGrid } from "../../src/core/tariff";
import {
  blankPrice,
  blankWindow,
  MONTHS,
  previewPrice,
  WEEKDAYS,
  type PriceDraft,
  type WindowDraft,
} from "@/lib/tariff";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/utils";

/** One colour per window, in list order; the base rate is the muted well. */
const WINDOW_COLORS = ["var(--brand)", "var(--success)", "var(--warning)", "var(--brand-2)", "var(--destructive)"];

export function windowColor(index: number): string {
  return index === BASE ? "var(--muted)" : WINDOW_COLORS[index % WINDOW_COLORS.length]!;
}

function Toggle({
  pressed,
  onClick,
  children,
  label,
}: {
  pressed: boolean;
  onClick: () => void;
  children: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      aria-label={label}
      onClick={onClick}
      className={cn(
        "h-7 min-w-9 rounded-md border px-1.5 text-xs font-medium transition-colors",
        pressed ? "border-primary bg-primary text-primary-foreground" : "bg-card text-muted-foreground hover:bg-muted",
      )}
    >
      {children}
    </button>
  );
}

function toggle(list: number[], value: number): number[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value].sort((a, b) => a - b);
}

/**
 * Which rate applies at each hour of the week: a 7 × 24 strip, one row per
 * weekday, coloured by window. It reads the draft exactly as the server's
 * matching will, so overlaps and midnight-crossing windows show as billed.
 */
function WeekPreview({ draft }: { draft: PriceDraft }) {
  const filtered = draft.windows.some((w) => w.months.length > 0 && w.months.length < 12);
  const [month, setMonth] = useState(new Date().getMonth() + 1);
  const grid = weekGrid(previewPrice(draft), month);
  return (
    <figure className="space-y-2" aria-label="Week preview">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <figcaption className="text-xs text-muted-foreground">Which rate applies when</figcaption>
        {filtered && (
          <Select
            aria-label="Preview month"
            className="w-24"
            value={month}
            onChange={(e) => setMonth(Number(e.target.value))}
          >
            {MONTHS.map((name, i) => (
              <option key={name} value={i + 1}>
                {name}
              </option>
            ))}
          </Select>
        )}
      </div>
      <div className="grid grid-cols-[2.25rem_1fr] gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground">
        {grid.map((row, d) => (
          <div key={WEEKDAYS[d]} className="contents">
            <span className="leading-3">{WEEKDAYS[d]}</span>
            <div className="grid h-3 grid-cols-24 gap-px overflow-hidden rounded-sm" data-testid="week-row">
              {row.map((window, h) => (
                <span
                  key={h}
                  title={`${WEEKDAYS[d]} ${String(h).padStart(2, "0")}:00 — ${
                    window === BASE ? "base rate" : draft.windows[window]?.label || `window ${window + 1}`
                  }`}
                  data-window={window}
                  style={{ backgroundColor: windowColor(window) }}
                />
              ))}
            </div>
          </div>
        ))}
        <span />
        <div className="flex justify-between tabular-nums">
          <span>00</span>
          <span>06</span>
          <span>12</span>
          <span>18</span>
          <span>24</span>
        </div>
      </div>
      <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <li className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm border" style={{ backgroundColor: windowColor(BASE) }} /> Base rate
        </li>
        {draft.windows.map((w, i) => (
          <li key={i} className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-sm" style={{ backgroundColor: windowColor(i) }} />
            {w.label.trim() || `Window ${i + 1}`}
          </li>
        ))}
      </ul>
    </figure>
  );
}

function WindowRow({
  window,
  index,
  currency,
  onChange,
  onRemove,
}: {
  window: WindowDraft;
  index: number;
  currency: CurrencyCode;
  onChange: (next: WindowDraft) => void;
  onRemove: () => void;
}) {
  const n = index + 1;
  return (
    <fieldset className="space-y-3 rounded-lg border p-3" aria-label={`Time window ${n}`}>
      <div className="flex flex-wrap items-end gap-3">
        <span className="mb-2 size-3 shrink-0 rounded-sm" style={{ backgroundColor: windowColor(index) }} />
        <div className="min-w-32 flex-1 space-y-1.5">
          <Label htmlFor={`window-${n}-label`}>Label</Label>
          <Input
            id={`window-${n}-label`}
            value={window.label}
            placeholder="Off-peak"
            onChange={(e) => onChange({ ...window, label: e.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`window-${n}-start`}>From</Label>
          <Input
            id={`window-${n}-start`}
            type="time"
            className="w-28"
            value={window.start}
            onChange={(e) => onChange({ ...window, start: e.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`window-${n}-end`}>Until</Label>
          <Input
            id={`window-${n}-end`}
            type="time"
            className="w-28"
            value={window.end}
            onChange={(e) => onChange({ ...window, end: e.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          {/* Not "Rate": the base field owns that word, and the stories find it by it. */}
          <Label htmlFor={`window-${n}-price`}>Price here ({currency})</Label>
          <Input
            id={`window-${n}-price`}
            className="w-28"
            inputMode="decimal"
            placeholder="0.12"
            value={window.rate}
            onChange={(e) => onChange({ ...window, rate: e.target.value })}
          />
        </div>
        <Button type="button" variant="ghost" size="icon" aria-label={`Remove time window ${n}`} onClick={onRemove}>
          <Trash2 />
        </Button>
      </div>
      <div className="flex flex-wrap gap-1" role="group" aria-label={`Weekdays of time window ${n}`}>
        {WEEKDAYS.map((day, i) => (
          <Toggle
            key={day}
            label={day}
            pressed={window.days.includes(i + 1)}
            onClick={() => onChange({ ...window, days: toggle(window.days, i + 1) })}
          >
            {day.slice(0, 2)}
          </Toggle>
        ))}
      </div>
      <div className="flex flex-wrap gap-1" role="group" aria-label={`Months of time window ${n}`}>
        {MONTHS.map((month, i) => (
          <Toggle
            key={month}
            label={month}
            pressed={window.months.length === 0 || window.months.includes(i + 1)}
            onClick={() => {
              // No months chosen means all of them; the first click narrows to "all but this one".
              const all = window.months.length === 0 ? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] : window.months;
              const next = toggle(all, i + 1);
              onChange({ ...window, months: next.length === 12 ? [] : next });
            }}
          >
            {month}
          </Toggle>
        ))}
      </div>
      {window.end <= window.start && (
        <p className="text-xs text-muted-foreground">
          {window.end === window.start
            ? "Runs a full 24 hours from its start."
            : "Crosses midnight: it runs from the chosen days' evenings into the next mornings."}
        </p>
      )}
    </fieldset>
  );
}

/**
 * The tariff part of the place form: dated prices, the one being edited, its
 * time windows and the week preview. Prices are drafts (typed text) until the
 * form saves; `lib/tariff` turns them into the API's shape.
 */
export function TariffEditor({
  prices,
  onChange,
  currency,
  today,
}: {
  prices: PriceDraft[];
  onChange: (prices: PriceDraft[]) => void;
  currency: CurrencyCode;
  /** The place's local day, for "New price from…". */
  today: string;
}) {
  const [selected, setSelected] = useState(Math.max(0, prices.length - 1));
  const [newFrom, setNewFrom] = useState<string | null>(null);
  const index = Math.min(selected, prices.length - 1);
  const draft = prices[index];

  const update = (next: PriceDraft) => onChange(prices.map((p, i) => (i === index ? next : p)));

  function addPrice(from: string) {
    // A new price starts as a copy of the latest, which is what changes from one
    // bill to the next: usually one rate, rarely the shape of the day.
    const latest = prices[prices.length - 1] ?? blankPrice(from);
    const copy: PriceDraft = { ...latest, validFrom: from, windows: latest.windows.map((w) => ({ ...w })) };
    const next = [...prices, copy].sort((a, b) => (a.validFrom < b.validFrom ? -1 : 1));
    onChange(next);
    setSelected(next.indexOf(copy));
    setNewFrom(null);
  }

  if (!draft) return null;

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Dated prices">
          {prices.map((p, i) => (
            <button
              key={`${p.validFrom}-${i}`}
              type="button"
              aria-pressed={i === index}
              onClick={() => setSelected(i)}
              className={cn(
                "rounded-full border px-3 py-1 text-xs font-medium tabular-nums transition-colors",
                i === index ? "border-primary bg-primary text-primary-foreground" : "hover:bg-muted",
              )}
            >
              From {p.validFrom || "…"}
            </button>
          ))}
          {newFrom === null ? (
            <Button type="button" variant="outline" size="sm" onClick={() => setNewFrom(today)}>
              <Plus /> New price from…
            </Button>
          ) : (
            <span className="flex items-center gap-2">
              <Input
                aria-label="New price starts on"
                type="date"
                className="w-40"
                value={newFrom}
                onChange={(e) => setNewFrom(e.target.value)}
              />
              <Button
                type="button"
                size="sm"
                disabled={!newFrom || prices.some((p) => p.validFrom === newFrom)}
                onClick={() => addPrice(newFrom)}
              >
                Add price
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => setNewFrom(null)}>
                Cancel
              </Button>
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          Each price applies from its day on, until the next one starts. A new price leaves earlier sessions at the
          price they had; correcting a price reprices the sessions it covers.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-4">
        <div className="space-y-1.5">
          <Label htmlFor="valid-from">Applies from</Label>
          <Input
            id="valid-from"
            type="date"
            value={draft.validFrom}
            onChange={(e) => update({ ...draft, validFrom: e.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="billing">Billed</Label>
          <Select
            id="billing"
            value={draft.billingType}
            onChange={(e) => update({ ...draft, billingType: e.target.value as PriceDraft["billingType"] })}
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
            value={draft.rate}
            onChange={(e) => update({ ...draft, rate: e.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="fee">Session fee ({currency})</Label>
          <Input
            id="fee"
            inputMode="decimal"
            placeholder="0.00"
            value={draft.sessionFee}
            onChange={(e) => update({ ...draft, sessionFee: e.target.value })}
          />
        </div>
      </div>

      <div className="space-y-3">
        {draft.windows.map((w, i) => (
          <WindowRow
            key={i}
            window={w}
            index={i}
            currency={currency}
            onChange={(next) => update({ ...draft, windows: draft.windows.map((x, j) => (j === i ? next : x)) })}
            onRemove={() => update({ ...draft, windows: draft.windows.filter((_, j) => j !== i) })}
          />
        ))}
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => update({ ...draft, windows: [...draft.windows, blankWindow()] })}
          >
            <Plus /> Add time window
          </Button>
          {draft.windows.length > 1 && (
            <span className="text-xs text-muted-foreground">
              Where windows overlap, the lower one in the list wins.
            </span>
          )}
          {prices.length > 1 && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="ml-auto text-destructive"
              onClick={() => {
                onChange(prices.filter((_, i) => i !== index));
                setSelected(Math.max(0, index - 1));
              }}
            >
              Remove this price
            </Button>
          )}
        </div>
      </div>

      {draft.windows.length > 0 && <WeekPreview draft={draft} />}
    </div>
  );
}
