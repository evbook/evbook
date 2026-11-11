/**
 * The name Tesla sells a trim under — `Performance`, `Long Range RWD`, `Plaid` —
 * from the `trim_badging` the car reports (`p74d`, `74`, `100d`, …).
 *
 * The badge only says pack and motors, so the model and the year decide the
 * name: a Model Y `74` is the Long Range RWD, and a `p100d` built from 2021 on
 * is a Plaid where an older one was the Ludicrous-era Performance. A badge with
 * no marketing name of its own (`P90D`, `75D` on an older S or X — those were
 * the names) is returned upper-cased, as the car wore it.
 */
export function trimMarketingName(input: {
  model: string | null | undefined;
  trimBadging: string | null | undefined;
  modelYear?: number | null;
  motorCount?: number | null;
}): string | null {
  const badge = input.trimBadging?.trim().toLowerCase();
  if (!badge) return null;
  const year = input.modelYear ?? null;

  switch (input.model) {
    case "3":
    case "Y":
      switch (badge) {
        case "p74d":
          return "Performance";
        case "74d":
          return "Long Range";
        case "74":
          return "Long Range RWD";
        case "62":
          return "Mid Range";
        case "50":
          return "Standard Range";
      }
      break;
    case "S":
    case "X":
      if (input.motorCount === 3 || (badge === "p100d" && year != null && year >= 2021)) return "Plaid";
      // From the 2019 refresh the 100 kWh dual motor was sold as the Long Range;
      // before it, `100D` was the name.
      if (badge === "100d" && year != null && year >= 2019) return "Long Range";
      if (badge === "p100d" && year != null && year >= 2019) return "Performance";
      break;
  }
  return badge.toUpperCase();
}
