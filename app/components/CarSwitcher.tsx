import type { CarDto } from "@shared/api-types";
import { Segmented } from "@/components/ui/segmented";

/** What a car is called on the switcher: its name, or the end of its VIN without one. */
export function carName(car: CarDto): string {
  return car.name ?? `VIN …${car.vin.slice(-6)}`;
}

/**
 * Which car the page is about, in the page header's right-hand corner on every page
 * that shows a car's data. Nothing at all with one car: a switch with one position
 * is a label pretending to be a control.
 *
 * Fed from `useCar`, which keeps every page on the same car — see `carStore`.
 */
export function CarSwitcher({
  cars,
  value,
  onChange,
}: {
  cars: readonly CarDto[];
  value: string;
  onChange: (carId: string) => void;
}) {
  if (cars.length < 2) return null;
  return (
    <Segmented
      label="Car"
      size="md"
      value={value}
      onChange={onChange}
      options={cars.map((car) => ({ value: String(car.id), label: carName(car) }))}
    />
  );
}
