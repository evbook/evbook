import { durationRange, spanOf, type NumberRange, type TimeSpan } from "@shared/uncertainty";

/**
 * The bounds a drive or charge row carries (migration 0006), selected and read
 * the same way everywhere a row becomes a DTO.
 */
export function uncertaintyColumns(alias: string): string {
  return ["start_after_at", "start_before_at", "end_after_at", "end_before_at", "reconstructed"]
    .map((c) => `${alias}.${c}`)
    .join(", ");
}

export interface UncertaintyRow {
  start_date_at: number;
  end_date_at: number | null;
  start_after_at: number | null;
  start_before_at: number | null;
  end_after_at: number | null;
  end_before_at: number | null;
  reconstructed: number;
}

export function uncertainty(row: UncertaintyRow): {
  startSpan: TimeSpan | null;
  endSpan: TimeSpan | null;
  durationRangeMin: NumberRange | null;
  reconstructed: boolean;
} {
  const startSpan = spanOf(row.start_date_at, row.start_after_at, row.start_before_at);
  const endSpan = spanOf(row.end_date_at, row.end_after_at, row.end_before_at);
  const reconstructed = row.reconstructed === 1;
  return {
    startSpan,
    endSpan,
    // A reconstructed event has no duration at all, not a range of them.
    durationRangeMin: reconstructed
      ? null
      : durationRange({ at: row.start_date_at, span: startSpan }, { at: row.end_date_at, span: endSpan }),
    reconstructed,
  };
}
