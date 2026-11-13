import { PENDING_SETTINGS, useAppSettings } from "@/hooks/useAppSettings";
import { formatDate, type DateFormat } from "@/lib/datetime";

/**
 * A date or a time on the page: the one component every page uses for one.
 *
 * It reads in the browser's locale and the account's time zone (see
 * `lib/datetime.ts`, which also lists the formats), and renders a `<time>`
 * carrying the exact instant, so the page says the same thing to a screen
 * reader or a script as it does to the eye. `timezone` is only for the rare
 * caller showing some other zone than the account's.
 */
export function DateTime({
  at,
  format = "dateTime",
  timezone,
  className,
}: {
  /** Epoch milliseconds; nothing renders as a dash. */
  at: number | null | undefined;
  format?: DateFormat;
  timezone?: string;
  className?: string;
}) {
  const settings = useAppSettings();
  const zone = timezone ?? settings.data?.timezone ?? PENDING_SETTINGS.timezone;
  if (at == null || !Number.isFinite(at)) return className ? <span className={className}>–</span> : "–";
  return (
    <time dateTime={new Date(at).toISOString()} className={className}>
      {formatDate(at, format, zone)}
    </time>
  );
}
