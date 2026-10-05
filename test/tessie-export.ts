import { buildZip } from "./zipfile";

/**
 * A small export shaped exactly like Tessie's: one file per metric group, every
 * field quoted, units in the header, naive UTC timestamps ascending.
 *
 * One morning: a drive out, a charge, a drive back — enough for the import to
 * produce two drives, one charging session and a sleep, which is what the
 * pipeline specs assert on.
 */

export const TESSIE_VIN = "LRW3F7EB9MC123456";
export const TESSIE_DAY = "2024-05-01";

export function tessieCsvFiles(days = 1): Record<string, string> {
  const driving = ["Timestamp (UTC),Latitude,Longitude,Shift State,Odometer (mi),Speed (mph)"];
  const charging = [
    "Timestamp (UTC),Charging State,Usable Battery Level (%),Battery Range (mi),Ideal Battery Range (mi),Charge Rate (mph),Charger Current (A),Charger Phases,Charger Power (kW),Charger Voltage (V)",
  ];
  const climate = ["Timestamp (UTC),Climate Enabled,Inside Temp (°C),Outside Temp (°C)"];
  const vehicle = ["Timestamp (UTC),Locked,Sentry Mode"];
  const battery = [
    "Timestamp (UTC),Lifetime Energy Used (kWh),Energy Remaining (kWh),Pack Current (A),Pack Voltage (V),Min Battery Module Temp (°C),Max Battery Module Temp (°C)",
  ];

  const day0 = Date.parse(`${TESSIE_DAY}T00:00:00Z`);
  const stamp = (day: number, minute: number) =>
    new Date(day0 + day * 86_400_000 + (8 * 60 + minute) * 60_000).toISOString().slice(0, 19).replace("T", " ");

  let odometer = 1000;
  for (let day = 0; day < days; day++) {
    // 08:00-08:10 driving 20 km, 08:12-08:30 charging, 08:40-08:50 driving back.
    for (let minute = 0; minute <= 10; minute++) {
      odometer += minute === 0 ? 0 : 1.2427; // 2 km a minute
      driving.push(
        `"${stamp(day, minute)}","52.52","13.40${minute % 10}","${minute === 10 ? "P" : "D"}","${odometer.toFixed(4)}","40"`,
      );
    }
    for (let minute = 40; minute <= 50; minute++) {
      odometer += minute === 40 ? 0 : 1.2427;
      driving.push(
        `"${stamp(day, minute)}","52.53","13.41${minute % 10}","${minute === 50 ? "P" : "D"}","${odometer.toFixed(4)}","40"`,
      );
    }

    for (let minute = 0; minute <= 55; minute++) {
      const state = minute >= 12 && minute <= 30 ? "Charging" : minute > 30 && minute < 40 ? "Complete" : "Disconnected";
      const level = 50 + (minute >= 12 ? Math.min(minute - 12, 18) : 0);
      const power = state === "Charging" ? 11 : 0;
      const phases = state === "Charging" ? "1" : "";
      charging.push(
        `"${stamp(day, minute)}","${state}","${level}","${(level * 3).toFixed(2)}","${(level * 2.9).toFixed(2)}","0","16","${phases}","${power}","230"`,
      );
      climate.push(`"${stamp(day, minute)}","0","21.5","18.${minute % 10}"`);
      vehicle.push(`"${stamp(day, minute)}","1","0"`);
      if (minute % 2 === 0) {
        const energy = 40 + (minute >= 12 ? Math.min(minute - 12, 18) * 0.5 : 0);
        battery.push(`"${stamp(day, minute)}","5790.5","${energy}","${state === "Charging" ? 16 : -1}","400","18","19"`);
      }
    }
  }

  return {
    "driving_states.csv": `${driving.join("\n")}\n`,
    "charging_states.csv": `${charging.join("\n")}\n`,
    "climate_states.csv": `${climate.join("\n")}\n`,
    "vehicle_states.csv": `${vehicle.join("\n")}\n`,
    "battery_states.csv": `${battery.join("\n")}\n`,
  };
}

/** The same export packed as a zip, the way a user would upload it. */
export function tessieZip(days = 1): Promise<Uint8Array> {
  return buildZip(
    Object.entries(tessieCsvFiles(days)).map(([name, content]) => ({ name, content, deflate: true })),
  );
}
