#!/usr/bin/env node
/**
 * The one mock server the project uses: Tesla's Owner API, OSM Nominatim and
 * Open-Meteo's elevation API, all served from the generated world so a local
 * worker never needs the network.
 *
 *   node e2e/mocks/server.mjs [--port 9099] [--scenario parked|driving|charging|asleep]
 *                             [--manifest e2e/.artifacts/manifest.json]
 *
 * Point a worker at it with, in .dev.vars:
 *   TESLA_API_HOST=http://localhost:9099
 *   TESLA_AUTH_ISSUER=http://localhost:9099/oauth2/v3
 *   NOMINATIM_HOST=http://localhost:9099
 *   ELEVATION_HOST=http://localhost:9099
 *
 * Tests drive it over its own control endpoints:
 *   POST /scenario/driving          switch what the car is doing
 *   POST /__mock/state {batteryLevel, latitude, …}   nudge the live values
 *   GET  /__mock/state              read them back
 */

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDataset } from "./generate.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function flag(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

/**
 * The live state comes from a manifest when one has been generated, and falls
 * back to generating the world on the fly for plain `npm run dev`.
 */
function loadManifest(path) {
  if (path) {
    try {
      return JSON.parse(readFileSync(resolve(ROOT, path), "utf8"));
    } catch {
      // Fall through to a freshly generated world.
    }
  }
  return buildDataset({ now: Date.now() }).manifest;
}

export function createMockServer({ manifestPath, scenario = "parked" } = {}) {
  const manifest = loadManifest(manifestPath);
  const { car, live, places } = manifest;

  const state = {
    scenario,
    latitude: live.lat,
    longitude: live.lon,
    odometerMi: live.odometerKm * 0.62137119223733,
    batteryLevel: live.batteryLevel,
    ratedRangeMi: live.ratedRangeKm * 0.62137119223733,
    energyAdded: 0,
    polls: 0,
    softwareVersion: live.softwareVersion,
    /** The last destination shared to the car's nav, for tests to read back. */
    lastDestination: null,
  };

  const round = (n, digits = 1) => {
    const f = 10 ** digits;
    return Math.round(n * f) / f;
  };

  function vehicleData() {
    state.polls++;
    const driving = state.scenario === "driving";
    const charging = state.scenario === "charging";

    if (driving) {
      state.odometerMi += 0.35;
      state.ratedRangeMi -= 0.4;
      state.latitude += 0.0004;
      state.longitude += 0.0006;
      if (state.polls % 12 === 0) state.batteryLevel = Math.max(5, state.batteryLevel - 1);
    }
    if (charging) {
      state.energyAdded += 0.4;
      state.ratedRangeMi += 0.9;
      if (state.polls % 4 === 0) state.batteryLevel = Math.min(100, state.batteryLevel + 1);
    }

    const now = Date.now();
    return {
      id: car.eid,
      vehicle_id: car.vid,
      vin: car.vin,
      display_name: car.name,
      state: "online",
      drive_state: {
        timestamp: now,
        latitude: round(state.latitude, 6),
        longitude: round(state.longitude, 6),
        speed: driving ? 42 + (state.polls % 7) * 3 : null,
        power: driving ? 24 : charging ? -11 : 0,
        shift_state: driving ? "D" : null,
        heading: (state.polls * 11) % 360,
        active_route_destination: driving ? "Fixture Depot" : null,
        active_route_latitude: driving ? round(state.latitude + 0.02, 6) : null,
        active_route_longitude: driving ? round(state.longitude + 0.03, 6) : null,
        active_route_miles_to_arrival: driving ? 4.6 : null,
        active_route_minutes_to_arrival: driving ? 12.4 : null,
        active_route_traffic_minutes_delay: driving ? 2 : null,
        active_route_energy_at_arrival: driving ? Math.max(1, state.batteryLevel - 3) : null,
      },
      charge_state: {
        timestamp: now,
        charging_state: charging ? "Charging" : "Disconnected",
        battery_level: state.batteryLevel,
        usable_battery_level: state.batteryLevel - 1,
        battery_range: round(state.ratedRangeMi),
        est_battery_range: round(state.ratedRangeMi * 0.94),
        ideal_battery_range: round(state.ratedRangeMi * 1.09),
        charge_energy_added: round(state.energyAdded),
        charger_actual_current: charging ? 16 : 0,
        charger_phases: charging ? 3 : null,
        charger_pilot_current: 16,
        charger_power: charging ? 11 : 0,
        charger_voltage: charging ? 232 : 0,
        conn_charge_cable: charging ? "IEC" : "<invalid>",
        fast_charger_present: false,
        fast_charger_brand: "<invalid>",
        fast_charger_type: "<invalid>",
        not_enough_power_to_heat: false,
        battery_heater_on: false,
        charge_limit_soc: 80,
        charge_port_door_open: charging,
        time_to_full_charge: charging ? 1.75 : 0,
        scheduled_charging_start_time: null,
        charge_rate: charging ? 29.4 : 0,
        scheduled_charging_pending: false,
        trip_charging: false,
      },
      climate_state: {
        timestamp: now,
        outside_temp: live.outsideTempC,
        inside_temp: driving ? live.insideTempC - 0.5 : live.insideTempC,
        is_preconditioning: false,
        climate_keeper_mode: "off",
        battery_heater: false,
        battery_heater_no_power: false,
        fan_status: driving ? 3 : 0,
        is_climate_on: driving,
        driver_temp_setting: 21,
        passenger_temp_setting: 21,
        is_rear_defroster_on: false,
        is_front_defroster_on: false,
        cabin_overheat_protection: "On",
        cabin_overheat_protection_actively_cooling: false,
        auto_seat_climate_left: true,
        auto_seat_climate_right: false,
        auto_steering_wheel_heat: false,
      },
      vehicle_state: {
        timestamp: now,
        odometer: round(state.odometerMi, 3),
        car_version: state.softwareVersion,
        locked: !driving,
        sentry_mode: state.scenario === "parked",
        is_user_present: driving,
        service_mode: false,
        df: 0,
        pf: 0,
        dr: 0,
        pr: 0,
        ft: 0,
        rt: 0,
        fd_window: 0,
        fp_window: 0,
        rd_window: 0,
        rp_window: 0,
        tpms_pressure_fl: live.tyrePressureBar.fl,
        tpms_pressure_fr: live.tyrePressureBar.fr,
        tpms_pressure_rl: live.tyrePressureBar.rl,
        tpms_pressure_rr: live.tyrePressureBar.rr,
        tpms_soft_warning_fl: false,
        tpms_soft_warning_fr: false,
        tpms_soft_warning_rl: true,
        tpms_soft_warning_rr: false,
        dashcam_state: state.scenario === "parked" ? "Recording" : "Unavailable",
        software_update: { status: "", version: "", download_perc: 0, install_perc: 0 },
      },
      vehicle_config: {
        car_type: car.carType,
        trim_badging: car.trimBadging,
        exterior_color: car.exteriorColor,
        wheel_type: car.wheelType,
        spoiler_type: car.spoilerType,
        car_special_type: "base",
      },
    };
  }

  /** Nearest known place within ~600 m, so addresses match the seeded ones. */
  function nearestPlace(lat, lon) {
    let best = null;
    for (const [key, place] of Object.entries(places)) {
      const dx = (lon - place.lon) * 0.61;
      const dy = lat - place.lat;
      const km = Math.sqrt(dx * dx + dy * dy) * 111.32;
      if (!best || km < best.km) best = { key, place, km };
    }
    return best && best.km < 0.6 ? best : null;
  }

  /** Nominatim's reverse-geocoding response shape. */
  function reverse(lat, lon) {
    const match = nearestPlace(lat, lon);
    const address = match?.place.address ?? { road: "Unbenannte Straße", city: "Berlin", postcode: "10000" };
    const name = match?.place.name ?? null;
    const id = match ? Object.keys(places).indexOf(match.key) + 1 : 900;
    return {
      place_id: 500_000 + id,
      osm_id: 100_000 + id,
      osm_type: "way",
      lat: String(lat),
      lon: String(lon),
      name,
      display_name: [
        [address.road, address.houseNumber].filter(Boolean).join(" "),
        address.postcode,
        address.city,
        "Germany",
      ]
        .filter(Boolean)
        .join(", "),
      address: {
        road: address.road,
        house_number: address.houseNumber,
        city: address.city,
        postcode: address.postcode,
        state: "Berlin",
        country: "Germany",
        country_code: "de",
      },
    };
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (url.pathname === "/health") return send(200, { ok: true, scenario: state.scenario });

    // ---- Tesla Owner API ----
    if (req.method === "POST" && url.pathname.endsWith("/token")) {
      return send(200, {
        access_token: "fixture-access-token",
        refresh_token: "fixture-refresh-token",
        expires_in: 28_800,
        token_type: "Bearer",
      });
    }
    if (url.pathname === "/api/1/products") {
      return send(200, {
        response: [{ id: car.eid, vehicle_id: car.vid, vin: car.vin, display_name: car.name, state: "online" }],
      });
    }
    if (url.pathname === `/api/1/vehicles/${car.eid}/vehicle_data`) {
      if (state.scenario === "asleep") {
        return send(408, { error: "vehicle unavailable: vehicle is offline or asleep" });
      }
      return send(200, { response: vehicleData() });
    }
    if (req.method === "POST" && url.pathname === `/api/1/vehicles/${car.eid}/wake_up`) {
      // A real wake takes tens of seconds; the mock's car simply obeys.
      if (state.scenario === "asleep") state.scenario = "parked";
      return send(200, { response: { id: car.eid, state: "online" } });
    }
    if (req.method === "POST" && url.pathname === `/api/1/vehicles/${car.eid}/command/navigation_request`) {
      if (state.scenario === "asleep") {
        return send(408, { error: "vehicle unavailable: vehicle is offline or asleep" });
      }
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        let parsed = null;
        try {
          parsed = JSON.parse(body || "{}");
        } catch {
          // Falls through to the shape check below.
        }
        const text = parsed?.value?.["android.intent.extra.TEXT"];
        // The shape check doubles as a client test: a body the real API would
        // reject comes back result:false here too.
        if (parsed?.type !== "share_ext_content_raw" || typeof text !== "string" || text === "") {
          return send(200, { response: { result: false, reason: "invalid request" } });
        }
        state.lastDestination = text;
        return send(200, { response: { result: true, reason: "" } });
      });
      return undefined;
    }
    if (url.pathname === `/api/1/vehicles/${car.eid}`) {
      return send(200, {
        response: { id: car.eid, state: state.scenario === "asleep" ? "asleep" : "online" },
      });
    }

    // ---- Nominatim ----
    if (url.pathname === "/reverse") {
      const lat = Number(url.searchParams.get("lat"));
      const lon = Number(url.searchParams.get("lon"));
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return send(400, { error: "bad_coordinates" });
      // `layer=poi` is a different question, and answering it with the address
      // would have the worker treat every street as a point of interest. Only a
      // place that declares a `poi` category is one; the rest get what the real
      // Nominatim gives when it finds nothing in that layer.
      if ((url.searchParams.get("layer") ?? "").split(",").includes("poi")) {
        const match = nearestPlace(lat, lon);
        if (!match?.place.poi) return send(200, { error: { code: 404, message: "Unable to geocode" } });
        const [category, type] = String(match.place.poi).split("/");
        return send(200, { ...reverse(lat, lon), name: match.place.name, category, type });
      }
      return send(200, reverse(lat, lon));
    }

    // ---- Open-Meteo elevation ----
    if (url.pathname === "/v1/elevation") {
      const lats = (url.searchParams.get("latitude") ?? "").split(",").filter(Boolean).map(Number);
      const lons = (url.searchParams.get("longitude") ?? "").split(",").filter(Boolean).map(Number);
      if (lats.length === 0 || lats.length !== lons.length || [...lats, ...lons].some((n) => !Number.isFinite(n))) {
        return send(400, { error: "bad_coordinates" });
      }
      // Berlin is flat, so a constant would make an elevation chart that proves
      // nothing. Deriving a gentle relief from the coordinate gives the story
      // screens a profile with a shape, and the same point always the same height.
      return send(200, {
        elevation: lats.map((lat, i) => 34 + Math.round(12 * Math.sin(lat * 120) + 8 * Math.cos(lons[i] * 140))),
      });
    }

    // ---- Control plane ----
    if (req.method === "POST" && url.pathname.startsWith("/scenario/")) {
      state.scenario = url.pathname.split("/")[2];
      return send(200, { scenario: state.scenario });
    }
    if (url.pathname === "/__mock/state") {
      if (req.method !== "POST") return send(200, state);
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        try {
          Object.assign(state, JSON.parse(body || "{}"));
          send(200, state);
        } catch {
          send(400, { error: "bad_json" });
        }
      });
      return undefined;
    }

    return send(404, { error: "not_found" });
  });

  return { server, state, manifest };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(flag("port", 9099));
  const { server, manifest } = createMockServer({
    manifestPath: flag("manifest", "e2e/.artifacts/manifest.json"),
    scenario: flag("scenario", "parked"),
  });
  server.listen(port, () => {
    console.log(`Mock Tesla + Nominatim on http://localhost:${port}`);
    console.log(`  car: ${manifest.car.name} (${manifest.counts.drives} drives seeded)`);
  });
}
