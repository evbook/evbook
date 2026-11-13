/**
 * Every date and time the app shows, formatted in one place.
 *
 * Two things decide how an instant reads, and they come from different people.
 * The *locale* — word order, month names, 24-hour or am/pm — is the reader's,
 * so it is the browser's (`undefined` below), never a hard-coded one. The *time
 * zone* is the account's, from Settings, so a drive just after midnight in
 * Berlin is dated in Berlin wherever the browser happens to be.
 *
 * What is left to choose is which fields to show, and that is the table below:
 * a call site names a format rather than spelling out its own options, so the
 * same kind of date reads the same on every page. `<DateTime>` renders one of
 * these as a `<time>` element; the few places that need a bare string — a chart
 * axis, a `title`, a sentence built from several times — call `formatDate`,
 * which is what the component calls too.
 */
export const DATE_FORMATS = {
  /** "22:49" */
  time: { hour: "2-digit", minute: "2-digit" },
  /** "12 Nov 2026" */
  date: { year: "numeric", month: "short", day: "2-digit" },
  /** "12 Nov 2026, 22:49" */
  dateTime: { year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" },
  /** "Thu, 12 Nov 2026": a day as a list row leads with it. */
  weekdayDate: { weekday: "short", year: "numeric", month: "short", day: "numeric" },
  /** "Thursday 12 November": today, said in full. */
  longDay: { weekday: "long", day: "numeric", month: "long" },
  /** "12 Nov": an axis tick within a year. */
  dayMonth: { month: "short", day: "2-digit" },
  /** "Nov 26": an axis tick across years. */
  monthYear: { month: "short", year: "2-digit" },
  /** "November" */
  month: { month: "long" },
  /** "November 2026" */
  longMonth: { month: "long", year: "numeric" },
  /** "2026" */
  year: { year: "numeric" },
  // The three pieces a range like "3 – 9 Nov 2026" is put together from.
  /** "3" */
  rangeDay: { day: "numeric" },
  /** "3 Nov" */
  rangeDayMonth: { day: "numeric", month: "short" },
  /** "9 Nov 2026" */
  rangeDate: { day: "numeric", month: "short", year: "numeric" },
} as const satisfies Record<string, Intl.DateTimeFormatOptions>;

export type DateFormat = keyof typeof DATE_FORMATS;

/**
 * Formatters are kept: building one is the expensive part of formatting, and a
 * chart asks for the same one for every tick it draws.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(format: DateFormat, timezone: string): Intl.DateTimeFormat {
  const key = `${format}|${timezone}`;
  let found = formatters.get(key);
  if (!found) {
    found = new Intl.DateTimeFormat(undefined, { timeZone: timezone, ...DATE_FORMATS[format] });
    formatters.set(key, found);
  }
  return found;
}

/** An instant as text, or a dash when there is none. */
export function formatDate(at: number | null | undefined, format: DateFormat, timezone: string): string {
  if (at == null) return "–";
  return formatter(format, timezone).format(at);
}
