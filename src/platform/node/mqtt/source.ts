import { findGeofence } from "../../../core/geo/geofence";
import type { AppEnv } from "../../env";
import type { MqttCar, MqttSource } from "./publisher";

/**
 * Today's source: each car's live summary, read the way the car page reads it
 * (`getSummary()` answers from stored state and asks the car nothing), plus
 * the car's name and the geofence its position falls in. The summary snapshot
 * from the HA proposal (§1.2) replaces this once it exists.
 */
export function liveSummaries(env: AppEnv): MqttSource {
  return {
    async cars(): Promise<MqttCar[]> {
      const cars = await env.DB.prepare("SELECT id, name FROM cars ORDER BY id").all<{
        id: number;
        name: string | null;
      }>();
      if (cars.results.length === 0) return [];
      const geofences = await env.DB.prepare("SELECT id, name, latitude, longitude, radius FROM geofences").all<{
        id: number;
        name: string;
        latitude: number;
        longitude: number;
        radius: number;
      }>();

      const out: MqttCar[] = [];
      for (const car of cars.results) {
        const summary = await env.actors.vehicle(car.id).getSummary();
        if (!summary) continue;
        const inside = findGeofence(summary, geofences.results);
        const geofence = inside ? (geofences.results.find((g) => g.id === inside.id)?.name ?? null) : null;
        out.push({ id: car.id, summary, extras: { displayName: car.name, geofence } });
      }
      return out;
    },
  };
}
