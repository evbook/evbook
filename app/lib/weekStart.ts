import { ISO_FIRST_DAY, type FirstDay } from "@shared/timeBuckets";

/**
 * Which day the viewer's locale starts its weeks on, so "1W" means the week they
 * would draw on paper — Monday across most of Europe, Sunday in the US and much
 * of Asia, Saturday in much of the Middle East.
 *
 * `weekInfo` went through the spec as a getter and came out as a method, so both
 * spellings are in the wild, and some runtimes have neither. Anything unexpected
 * falls back to Monday, which is what ISO weeks mean and what the server's
 * grouped statistics use.
 */
export function localeWeekStart(locale?: string): FirstDay {
  try {
    const tag = locale ?? (typeof navigator === "undefined" ? undefined : navigator.language);
    if (!tag) return ISO_FIRST_DAY;
    const resolved = new Intl.Locale(tag) as Intl.Locale & {
      weekInfo?: { firstDay?: number };
      getWeekInfo?: () => { firstDay?: number };
    };
    const info = typeof resolved.getWeekInfo === "function" ? resolved.getWeekInfo() : resolved.weekInfo;
    const firstDay = info?.firstDay;
    return firstDay != null && firstDay >= 1 && firstDay <= 7 ? (firstDay as FirstDay) : ISO_FIRST_DAY;
  } catch {
    return ISO_FIRST_DAY;
  }
}
