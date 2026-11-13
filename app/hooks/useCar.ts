import { useSyncExternalStore } from "react";
import type { CarDto } from "@shared/api-types";
import { currentCar, saveCar, subscribeCar } from "@/lib/carStore";
import { useCars } from "@/hooks/useAppSettings";

/**
 * The car every page is showing, and the way to change it.
 *
 * Always a car once the list is in — the remembered one if it is still on the account,
 * otherwise the first — because no page shows more than one car's data. `carId` is
 * empty only while the list is loading or the account has no cars, and every query
 * that takes it waits for it rather than asking for every car in the meantime.
 *
 * `among` narrows which cars are on offer: the Overview, which is about the present,
 * offers only the cars being logged. A remembered car outside it falls back to the
 * first one there without forgetting the pick, so the other pages keep showing it.
 */
export function useCar(among?: (car: CarDto) => boolean) {
  const query = useCars();
  const chosen = useSyncExternalStore(subscribeCar, currentCar, () => null);

  const cars = among ? (query.data ?? []).filter(among) : (query.data ?? []);
  const car = cars.find((c) => String(c.id) === chosen) ?? cars[0] ?? null;

  return { car, carId: car ? String(car.id) : "", cars, choose: saveCar, query };
}
