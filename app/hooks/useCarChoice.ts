import { useCallback, useState } from "react";
import { readCar, saveCar } from "@/lib/carStore";

/**
 * The remembered car, for a page whose only filter is which car.
 *
 * The lists and the timeline carry the car in their filter state, where `useUrlFilters`
 * keeps it in step with `carStore`; Statistics and Health have nothing else to put in a
 * URL, so they hold the choice here and share the same store — picking a car on either
 * of them means the same thing everywhere else, and the other way round.
 *
 * Read once at mount, for the same reason the range is: the store is where the choice
 * comes from, not a second copy to keep in step while the page is open.
 */
export function useCarChoice() {
  const [carId, setCarId] = useState(() => readCar() ?? "");

  const choose = useCallback((next: string) => {
    saveCar(next);
    setCarId(next);
  }, []);

  return [carId, choose] as const;
}
