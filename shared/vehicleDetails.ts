import type { VehicleDetailsDto } from "./api-types";

/**
 * The rows Settings shows for a car whose VIN EVBook cannot decode, from what its
 * provider reports (`CarDto.details`): the same shape as `vinDetailRows` gives a
 * Tesla, top to bottom, each row only when there is a value.
 *
 * `formatDay` turns the first registration (YYYY-MM-DD) into the user's date
 * format; it is a day, not a moment, so it is never shifted by a time zone.
 */
export function vehicleDetailRows(
  car: { model: string | null; vin: string },
  details: VehicleDetailsDto,
  formatDay: (isoDay: string) => string,
): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = [];
  const add = (label: string, value: string | null | undefined) => {
    if (value) rows.push({ label, value });
  };
  const kg = (n: number) => `${new Intl.NumberFormat("en-US").format(Math.round(n))} kg`;

  add("Model", [details.modelYear, car.model].filter(Boolean).join(" "));
  add(
    "Drive",
    [details.driveType, details.enginePowerKw && `${Math.round(details.enginePowerKw)} kW`].filter(Boolean).join(" · "),
  );
  add("Pack", details.batteryCapacityKwh ? `${details.batteryCapacityKwh} kWh` : null);
  add("First registration", details.firstRegistration ? formatDay(details.firstRegistration) : null);
  add("Colour", details.colour);
  add("Seats", details.seats ? String(details.seats) : null);
  add(
    "Weight",
    [
      details.curbWeightKg && `${kg(details.curbWeightKg)} kerb`,
      details.grossWeightKg && `${kg(details.grossWeightKg)} gross`,
    ]
      .filter(Boolean)
      .join(" · "),
  );
  // Positions 12–17, as `vinDetailRows` reads a Tesla's.
  add("Serial", car.vin.length === 17 ? car.vin.slice(11) : null);
  return rows;
}

/**
 * The line under a car's name from its provider's details, the way a Tesla's
 * reads "2018 Model S 100D": year, model, drive — "2022 XC40 AWD". Null when
 * there is nothing beyond the model to say.
 */
export function vehicleSubtitle(model: string | null, details: VehicleDetailsDto | null | undefined): string | null {
  if (!details || (details.modelYear == null && !details.driveType)) return null;
  return [details.modelYear, model, details.driveType].filter(Boolean).join(" ") || null;
}
