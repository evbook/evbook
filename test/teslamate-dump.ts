/**
 * Hand-written TeslaMate backups for the import specs — no real user's data.
 *
 * Two schema generations, laid out the way `pg_dump` writes a plain dump: a
 * header, DDL, then one COPY block per table in name order (so `charges` comes
 * before `charging_processes`, and `positions` after `drives`), `setval` lines,
 * and the constraints. Fields are written exactly as COPY's text format has
 * them — `\N` for NULL and backslash escapes — which is the point: the parser
 * has to undo them.
 *
 * NEW_DUMP (TeslaMate 1.2x–2.x layout): two cars, fractional-second timestamps,
 * geofence billing, costs, drive ascent/descent (which EVBook does not keep).
 * OLD_DUMP (an early 1.x layout): one car, columns in another order, fewer of
 * them, no `updates` table and no geofences at all.
 */

export const NEW_VIN_1 = "5YJ3E7EB2LF000001";
export const NEW_VIN_2 = "LRW3E7FS9NC000002";
export const OLD_VIN = "5YJSA7E26JF000003";

/** One COPY block. Fields are raw COPY text — escapes and `\N` as written. */
function copy(table: string, columns: string[], rows: string[][]): string {
  const lines = rows.map((row) => {
    if (row.length !== columns.length) throw new Error(`${table}: ${row.length} fields for ${columns.length} columns`);
    return row.join("\t");
  });
  return [`COPY ${table} (${columns.join(", ")}) FROM stdin;`, ...lines, "\\.", "", ""].join("\n");
}

const N = "\\N";

const HEADER = `--
-- PostgreSQL database dump
--

-- Dumped from database version 16.4 (Debian 16.4-1.pgdg120+2)
-- Dumped by pg_dump version 16.4 (Debian 16.4-1.pgdg120+2)

SET statement_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);

CREATE TYPE public.billing_type AS ENUM (
    'per_kwh',
    'per_minute'
);

CREATE TYPE public.states_status AS ENUM (
    'online',
    'offline',
    'asleep'
);

`;

function ddl(tables: string[]): string {
  return tables
    .map(
      (table) =>
        `CREATE TABLE public.${table} (\n    id integer NOT NULL\n);\n\nALTER TABLE public.${table} OWNER TO teslamate;\n`,
    )
    .join("\n");
}

const FOOTER = `SELECT pg_catalog.setval('public.drives_id_seq', 4, true);
SELECT pg_catalog.setval('public.positions_id_seq', 30, true);

ALTER TABLE ONLY public.drives
    ADD CONSTRAINT drives_pkey PRIMARY KEY (id);

--
-- PostgreSQL database dump complete
--
`;

// ---- the newer layout ----

const NEW_TABLES = [
  "addresses",
  "car_settings",
  "cars",
  "charges",
  "charging_processes",
  "drives",
  "geofences",
  "positions",
  "schema_migrations",
  "settings",
  "states",
  "updates",
];

/** Two cars. Car 1 has the interesting history; car 2 is there to be told apart. */
export const NEW_DUMP =
  HEADER +
  ddl(NEW_TABLES) +
  "\n" +
  copy(
    "public.addresses",
    [
      "id",
      "display_name",
      "latitude",
      "longitude",
      "name",
      "house_number",
      "road",
      "neighbourhood",
      "city",
      "county",
      "postcode",
      "state",
      "state_district",
      "country",
      "raw",
      "inserted_at",
      "updated_at",
      "osm_id",
      "osm_type",
    ],
    [
      // A tab and a backslash in the display name, a newline inside the jsonb.
      [
        "1",
        "Home\\tSweet \\\\ Home, Hauptstraße 1, Berlin",
        "52.520008",
        "13.404954",
        N,
        "1",
        "Hauptstraße",
        N,
        "Berlin",
        N,
        "10115",
        "Berlin",
        N,
        "Deutschland",
        '{"note": "line one\\\\nline two"}',
        "2023-01-01 07:00:00",
        "2023-01-01 07:00:00",
        "1001",
        "way",
      ],
      // Octal-escaped UTF-8 (\303\251 is é) and no OSM id at all.
      [
        "2",
        "Caf\\303\\251 Central, Wien",
        "48.210033",
        "16.363449",
        "Caf\\303\\251 Central",
        N,
        N,
        N,
        "Wien",
        N,
        N,
        N,
        N,
        "Österreich",
        N,
        "2023-01-01 08:00:00.123456",
        "2023-01-01 08:00:00.123456",
        N,
        N,
      ],
      [
        "3",
        "Supercharger Großbeeren",
        "52.355000",
        "13.310000",
        "Supercharger",
        N,
        N,
        N,
        "Großbeeren",
        N,
        N,
        N,
        N,
        "Deutschland",
        N,
        "2023-01-01 18:00:00",
        "2023-01-01 18:00:00",
        "1003",
        "node",
      ],
    ],
  ) +
  copy(
    "public.car_settings",
    ["id", "suspend_min", "free_supercharging"],
    [
      ["1", "21", "f"],
      ["2", "21", "t"],
    ],
  ) +
  copy(
    "public.cars",
    [
      "id",
      "eid",
      "vid",
      "model",
      "efficiency",
      "inserted_at",
      "updated_at",
      "vin",
      "name",
      "trim_badging",
      "settings_id",
      "exterior_color",
      "spoiler_type",
      "wheel_type",
      "display_priority",
      "marketing_name",
    ],
    [
      [
        "1",
        "111",
        "211",
        "3",
        "0.153",
        "2022-12-01 00:00:00",
        "2023-01-05 00:00:00",
        NEW_VIN_1,
        "Bolt",
        "74D",
        "1",
        "MidnightSilver",
        N,
        "Pinwheel18",
        "1",
        "Long Range AWD",
      ],
      [
        "2",
        "112",
        "212",
        "Y",
        N,
        "2022-12-01 00:00:00",
        "2023-01-05 00:00:00",
        NEW_VIN_2,
        "Ypsilon",
        N,
        "2",
        N,
        N,
        N,
        "2",
        N,
      ],
    ],
  ) +
  copy(
    "public.charges",
    [
      "id",
      "date",
      "battery_heater_on",
      "battery_level",
      "charge_energy_added",
      "charger_actual_current",
      "charger_phases",
      "charger_pilot_current",
      "charger_power",
      "charger_voltage",
      "fast_charger_present",
      "conn_charge_cable",
      "fast_charger_brand",
      "fast_charger_type",
      "ideal_battery_range_km",
      "not_enough_power_to_heat",
      "outside_temp",
      "charging_process_id",
      "battery_heater",
      "battery_heater_no_power",
      "rated_battery_range_km",
      "usable_battery_level",
    ],
    [
      [
        "1",
        "2023-01-01 18:01:00.000000",
        "f",
        "20",
        "0.5",
        "16",
        "3",
        "16",
        "11",
        "230",
        "f",
        "IEC",
        N,
        "<invalid>",
        "100.0",
        N,
        "4.5",
        "1",
        "f",
        N,
        "95.0",
        "20",
      ],
      [
        "2",
        "2023-01-01 19:59:00.000000",
        "f",
        "80",
        "45.2",
        "16",
        "3",
        "16",
        "11",
        "231",
        "f",
        "IEC",
        N,
        "<invalid>",
        "400.0",
        N,
        "4.0",
        "1",
        "f",
        N,
        "380.0",
        "79",
      ],
      // The unfinished session's charges go with it.
      [
        "3",
        "2023-01-02 20:00:00.000000",
        "f",
        "50",
        "2.0",
        "16",
        "3",
        "16",
        "11",
        "230",
        "f",
        "IEC",
        N,
        N,
        "250.0",
        N,
        "3.0",
        "2",
        "f",
        N,
        "240.0",
        "50",
      ],
      [
        "4",
        "2023-01-04 12:10:00.000000",
        "f",
        "30",
        "10.0",
        "300",
        "\\N",
        "300",
        "120",
        "400",
        "t",
        "IEC",
        "Tesla",
        "Supercharger",
        "150.0",
        N,
        "6.0",
        "3",
        "f",
        N,
        "140.0",
        "30",
      ],
    ],
  ) +
  copy(
    "public.charging_processes",
    [
      "id",
      "start_date",
      "end_date",
      "charge_energy_added",
      "start_ideal_range_km",
      "end_ideal_range_km",
      "start_battery_level",
      "end_battery_level",
      "duration_min",
      "outside_temp_avg",
      "car_id",
      "position_id",
      "address_id",
      "start_rated_range_km",
      "end_rated_range_km",
      "geofence_id",
      "charge_energy_used",
      "cost",
    ],
    [
      [
        "1",
        "2023-01-01 18:00:00.000000",
        "2023-01-01 20:00:00.000000",
        "45.20",
        "100.0",
        "400.0",
        "20",
        "80",
        "120",
        "4.2",
        "1",
        "5",
        "1",
        "95.0",
        "380.0",
        "1",
        "49.50",
        "4.20",
      ],
      ["2", "2023-01-02 20:00:00.000000", N, "2.00", "250.0", N, "50", N, N, N, "1", "6", "1", "240.0", N, N, N, N],
      [
        "3",
        "2023-01-04 12:00:00.000000",
        "2023-01-04 12:30:00.000000",
        "10.00",
        "140.0",
        "260.0",
        "30",
        "60",
        "30",
        "6.0",
        "2",
        "9",
        "3",
        "130.0",
        "250.0",
        N,
        "10.40",
        "5.15",
      ],
    ],
  ) +
  copy(
    "public.drives",
    [
      "id",
      "start_date",
      "end_date",
      "outside_temp_avg",
      "speed_max",
      "power_max",
      "power_min",
      "start_ideal_range_km",
      "end_ideal_range_km",
      "start_km",
      "end_km",
      "distance",
      "duration_min",
      "car_id",
      "inside_temp_avg",
      "start_address_id",
      "end_address_id",
      "start_rated_range_km",
      "end_rated_range_km",
      "start_position_id",
      "end_position_id",
      "start_geofence_id",
      "end_geofence_id",
      "ascent",
      "descent",
    ],
    [
      [
        "1",
        "2023-01-01 08:00:00.000000",
        "2023-01-01 08:30:00.000000",
        "3.5",
        "120",
        "150",
        "-60",
        "300.0",
        "270.0",
        "10000.0",
        "10025.5",
        "25.5",
        "30",
        "1",
        "20.1",
        "1",
        "2",
        "290.0",
        "260.0",
        "1",
        "3",
        "1",
        N,
        "40",
        "35",
      ],
      // TeslaMate was still logging this one when the backup was taken.
      [
        "2",
        "2023-01-02 09:00:00.000000",
        N,
        N,
        N,
        N,
        N,
        "260.0",
        N,
        "10025.5",
        N,
        N,
        N,
        "1",
        N,
        "2",
        N,
        "250.0",
        N,
        "4",
        N,
        N,
        N,
        N,
        N,
      ],
      [
        "3",
        "2023-01-03 10:00:00.000000",
        "2023-01-03 10:20:00.000000",
        "2.0",
        "90",
        "80",
        "-30",
        "250.0",
        "235.0",
        "10030.0",
        "10042.0",
        "12.0",
        "20",
        "1",
        "19.0",
        "2",
        "1",
        "240.0",
        "226.0",
        "7",
        "8",
        N,
        "1",
        "5",
        "5",
      ],
      [
        "4",
        "2023-01-04 11:00:00.000000",
        "2023-01-04 11:40:00.000000",
        "6.0",
        "130",
        "200",
        "-80",
        "300.0",
        "150.0",
        "500.0",
        "560.0",
        "60.0",
        "40",
        "2",
        "21.0",
        "1",
        "3",
        "290.0",
        "140.0",
        "10",
        "11",
        N,
        N,
        N,
        N,
      ],
    ],
  ) +
  copy(
    "public.geofences",
    [
      "id",
      "name",
      "latitude",
      "longitude",
      "radius",
      "inserted_at",
      "updated_at",
      "cost_per_unit",
      "session_fee",
      "billing_type",
    ],
    [
      [
        "1",
        "Home",
        "52.520008",
        "13.404954",
        "50",
        "2022-12-01 00:00:00",
        "2022-12-01 00:00:00",
        "0.3200",
        "0.50",
        "per_kwh",
      ],
    ],
  ) +
  copy(
    "public.positions",
    [
      "id",
      "date",
      "latitude",
      "longitude",
      "speed",
      "power",
      "odometer",
      "ideal_battery_range_km",
      "battery_level",
      "outside_temp",
      "elevation",
      "fan_status",
      "driver_temp_setting",
      "passenger_temp_setting",
      "is_climate_on",
      "is_rear_defroster_on",
      "is_front_defroster_on",
      "car_id",
      "drive_id",
      "inside_temp",
      "battery_heater",
      "battery_heater_on",
      "battery_heater_no_power",
      "est_battery_range_km",
      "rated_battery_range_km",
      "usable_battery_level",
      "tpms_pressure_fl",
      "tpms_pressure_fr",
      "tpms_pressure_rl",
      "tpms_pressure_rr",
    ],
    [
      // Drive 1.
      pos("1", "2023-01-01 08:00:00.000000", "52.520008", "13.404954", "0", "1", "1", "10000.0", "60"),
      pos("2", "2023-01-01 08:15:00.000000", "52.400000", "13.380000", "110", "1", "1", "10012.0", "55"),
      pos("3", "2023-01-01 08:30:00.000000", "48.210033", "16.363449", "0", "1", "1", "10025.5", "50"),
      // Unfinished drive 2: left out with it.
      pos("4", "2023-01-02 09:00:00.000000", "48.210033", "16.363449", "0", "1", "2", "10025.5", "50"),
      // Parked: where the charging sessions began.
      pos("5", "2023-01-01 18:00:00.000000", "52.520008", "13.404954", "0", "1", N, "10025.5", "20"),
      pos("6", "2023-01-02 20:00:00.000000", "52.520008", "13.404954", "0", "1", N, "10025.5", "50"),
      // Drive 3.
      pos("7", "2023-01-03 10:00:00.000000", "48.210033", "16.363449", "0", "1", "3", "10030.0", "48"),
      pos("8", "2023-01-03 10:20:00.000000", "52.520008", "13.404954", "0", "1", "3", "10042.0", "45"),
      // Car 2.
      pos("9", "2023-01-04 12:00:00.000000", "52.355000", "13.310000", "0", "2", N, "560.0", "30"),
      pos("10", "2023-01-04 11:00:00.000000", "52.520008", "13.404954", "0", "2", "4", "500.0", "80"),
      pos("11", "2023-01-04 11:40:00.000000", "52.355000", "13.310000", "0", "2", "4", "560.0", "30"),
    ],
  ) +
  copy("public.schema_migrations", ["version", "inserted_at"], [["20230101000000", "2023-01-01 00:00:00"]]) +
  copy("public.settings", ["id", "unit_of_length", "base_url"], [["1", "km", "https://teslamate.example"]]) +
  copy(
    "public.states",
    ["id", "state", "start_date", "end_date", "car_id"],
    [
      ["1", "online", "2023-01-01 07:00:00.000000", "2023-01-01 09:00:00.000000", "1"],
      ["2", "asleep", "2023-01-01 09:00:00.000000", "2023-01-01 17:55:00.000000", "1"],
      ["3", "online", "2023-01-01 17:55:00.000000", "2023-01-03 12:00:00.000000", "1"],
      // Still open when the backup was taken.
      ["4", "asleep", "2023-01-03 12:00:00.000000", N, "1"],
      ["5", "online", "2023-01-04 10:00:00.000000", "2023-01-04 13:00:00.000000", "2"],
    ],
  ) +
  copy(
    "public.updates",
    ["id", "start_date", "end_date", "version", "car_id"],
    [
      ["1", "2023-01-01 02:00:00.000000", "2023-01-01 02:40:00.000000", "2022.44.25.1 a1b2c3d4e5f6", "1"],
      ["2", "2023-01-04 02:00:00.000000", "2023-01-04 02:30:00.000000", "2022.45.10 0f9e8d7c6b5a", "2"],
    ],
  ) +
  FOOTER;

function pos(
  id: string,
  date: string,
  latitude: string,
  longitude: string,
  speed: string,
  car: string,
  drive: string,
  odometer: string,
  level: string,
): string[] {
  return [
    id,
    date,
    latitude,
    longitude,
    speed,
    "5",
    odometer,
    "300.0",
    level,
    "4.5",
    "34",
    "0",
    "21.0",
    "21.0",
    "f",
    "f",
    "f",
    car,
    drive,
    "18.5",
    "f",
    "f",
    N,
    "280.0",
    "290.0",
    level,
    "2.9",
    "2.9",
    "2.95",
    "2.95",
  ];
}

// ---- an early layout ----

/**
 * An early 1.x schema: columns in another order, no rated ranges, no TPMS, no
 * usable level, plain-second timestamps, no `updates` and no `geofences`.
 */
export const OLD_DUMP =
  HEADER +
  ddl(["addresses", "cars", "charges", "charging_processes", "drives", "positions", "states"]) +
  "\n" +
  copy(
    "public.addresses",
    [
      "id",
      "display_name",
      "latitude",
      "longitude",
      "city",
      "country",
      "inserted_at",
      "updated_at",
      "osm_id",
      "osm_type",
    ],
    [
      [
        "7",
        "Bahnhofstrasse 1, Z\\303\\274rich",
        "47.376887",
        "8.541694",
        "Zürich",
        "Schweiz",
        "2020-05-01 06:00:00",
        "2020-05-01 06:00:00",
        "7007",
        "way",
      ],
    ],
  ) +
  copy(
    "public.cars",
    ["id", "eid", "vid", "model", "efficiency", "inserted_at", "updated_at", "vin", "name"],
    [["4", "400", "500", "S", "0.19", "2020-04-01 00:00:00", "2020-04-01 00:00:00", OLD_VIN, "Old \\\\ Faithful"]],
  ) +
  copy(
    "public.charges",
    [
      "id",
      "date",
      "charging_process_id",
      "battery_level",
      "charge_energy_added",
      "charger_power",
      "charger_voltage",
      "charger_actual_current",
      "charger_phases",
      "ideal_battery_range_km",
      "outside_temp",
    ],
    [
      ["20", "2020-05-01 20:05:00", "8", "40", "1.0", "7", "230", "32", "1", "200.0", "12.0"],
      ["21", "2020-05-01 21:55:00", "8", "60", "15.5", "7", "229", "32", "1", "300.0", "11.5"],
    ],
  ) +
  copy(
    "public.charging_processes",
    [
      "id",
      "car_id",
      "start_date",
      "end_date",
      "charge_energy_added",
      "start_battery_level",
      "end_battery_level",
      "duration_min",
      "address_id",
      "start_ideal_range_km",
      "end_ideal_range_km",
      "position_id",
    ],
    [
      [
        "8",
        "4",
        "2020-05-01 20:00:00",
        "2020-05-01 22:00:00",
        "15.50",
        "40",
        "60",
        "120",
        "7",
        "200.0",
        "300.0",
        "102",
      ],
    ],
  ) +
  copy(
    "public.drives",
    [
      "id",
      "car_id",
      "start_date",
      "end_date",
      "distance",
      "duration_min",
      "start_km",
      "end_km",
      "speed_max",
      "start_address_id",
      "end_address_id",
      "start_position_id",
      "end_position_id",
    ],
    [
      [
        "9",
        "4",
        "2020-05-01 07:00:00",
        "2020-05-01 07:45:00",
        "40.2",
        "45",
        "50000.0",
        "50040.2",
        "140",
        "7",
        "7",
        "100",
        "101",
      ],
    ],
  ) +
  copy(
    "public.positions",
    [
      "id",
      "car_id",
      "drive_id",
      "date",
      "latitude",
      "longitude",
      "speed",
      "power",
      "odometer",
      "battery_level",
      "ideal_battery_range_km",
      "outside_temp",
    ],
    [
      ["100", "4", "9", "2020-05-01 07:00:00", "47.376887", "8.541694", "0", "0", "50000.0", "70", "320.0", "10.0"],
      ["101", "4", "9", "2020-05-01 07:45:00", "47.376887", "8.541694", "0", "0", "50040.2", "50", "250.0", "12.0"],
      ["102", "4", N, "2020-05-01 20:00:00", "47.376887", "8.541694", N, N, "50040.2", "40", "200.0", "12.0"],
    ],
  ) +
  copy(
    "public.states",
    ["id", "car_id", "state", "start_date", "end_date"],
    [
      ["30", "4", "online", "2020-05-01 06:50:00", "2020-05-01 08:00:00"],
      ["31", "4", "asleep", "2020-05-01 08:00:00", "2020-05-01 19:50:00"],
    ],
  ) +
  FOOTER;

/** Epoch ms of a fixture timestamp, read as UTC. */
export function at(timestamp: string): number {
  return Date.parse(`${timestamp.replace(" ", "T")}Z`);
}

/** A dump as `gzip` would write it — what the import page recommends uploading. */
export async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
