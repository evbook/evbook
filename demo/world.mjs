/**
 * THE DEMO WORLD — two cars, three years, every screen with something to show.
 *
 * Same declarative shape as the e2e mock world, expanded by the same generator
 * (`e2e/mocks/generate.mjs`), but built to demonstrate the app rather than to
 * pin screenshots: a Berlin household with a 2019 Model 3 and a 2022 Model Y,
 * seasonal weather so range-vs-temperature has a real curve, square-root
 * battery fade so the capacity chart tells a story, and enough one-off trips
 * that the timeline, charging curves and AC-vs-DC screens all have material.
 *
 * The places and routes are in `geography.mjs`, and every route follows real
 * roads (`routes.json`): the commute and the errands around Prenzlauer Berg,
 * Sundays out to Potsdam, the Spreewald and the Brandenburg lakes, quarterly
 * Leipzig runs, and about twice a year a drive further — Prague, Vienna,
 * Amsterdam, Wrocław, Kraków, the Polish coast — so the density map and the
 * charging map look like a real household's.
 *
 * Days are relative to the seed moment, so the history always ends "now".
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PLACES, ROUTE_SPECS } from "./geography.mjs";
import { decodeTrack } from "./track.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const TIMEZONE = "Europe/Berlin";

/** Berlin's year: mean ~10.5 °C, ±9.5 °C over the seasons, coldest late January. */
const BERLIN_CLIMATE = { meanC: 10.5, amplitudeC: 9.5, coldestDayOfYear: 25, diurnalC: 6 };

/** Old drives keep a sketch of their track; recent ones stay chart-dense. */
const THINNING = { afterDays: 120, driveSamples: 8 };

/** One sample every 15 s on recent drives, as a logger polls; every 40 s on old ones. */
const SAMPLING = { recentSeconds: 15, oldSeconds: 40 };

/**
 * Routes with their road geometry (`routes.json`, from `fetch-routes.mjs`).
 * The track is [lat, lon, seconds]; the waypoints are its points, for the
 * generator's paths that only want a line.
 */
const ROUTES = (() => {
  const fetched = JSON.parse(readFileSync(join(HERE, "routes.json"), "utf8"));
  return Object.fromEntries(
    Object.entries(ROUTE_SPECS).map(([key, spec]) => {
      const geometry = fetched[key];
      if (!geometry) throw new Error(`demo route ${key} has no geometry — run: bun demo/fetch-routes.mjs`);
      const track = decodeTrack(geometry);
      return [
        key,
        {
          from: spec.from,
          to: spec.to,
          km: geometry.km,
          minutes: geometry.minutes,
          maxKmh: geometry.maxKmh,
          waypoints: track.map(([lat, lon]) => [lat, lon]),
          track,
        },
      ];
    }),
  );
})();

/**
 * Firmware releases, oldest first, as the fleet saw them. Each car installs a
 * subset on its own lag, so the software timeline differs between the two.
 */
const RELEASES = [
  { daysAgo: 1071, version: "2023.32.9 f2d0a1c" },
  { daysAgo: 1002, version: "2023.38.6 0b3c99e" },
  { daysAgo: 926, version: "2023.44.30.8 7aa41d0" },
  { daysAgo: 851, version: "2024.2.7 3b9e1f22" },
  { daysAgo: 778, version: "2024.8.9 c4d81a7" },
  { daysAgo: 704, version: "2024.14.9 91e0b6f" },
  { daysAgo: 633, version: "2024.20.7 5f7c2d9" },
  { daysAgo: 561, version: "2024.26.4 e8a90b3" },
  { daysAgo: 489, version: "2024.32.7 24c6f8d" },
  { daysAgo: 415, version: "2024.44.25.3 b0d19ae" },
  { daysAgo: 341, version: "2025.2.6 6e3ba24" },
  { daysAgo: 268, version: "2025.8.4 a1f07c5" },
  { daysAgo: 195, version: "2025.14.12 4d92e1b" },
  { daysAgo: 123, version: "2025.26.7 88c50f2" },
  { daysAgo: 58, version: "2026.8.4 c0f1a9d" },
  { daysAgo: 16, version: "2026.14.3 f9a1c2b" },
];

const updateEvents = (fromDaysAgo, installLagDays) =>
  RELEASES.filter((r) => r.daysAgo + installLagDays < fromDaysAgo).map((r) => ({
    on: { daysAgo: r.daysAgo + installLagDays },
    events: [{ kind: "update", at: "03:12", version: r.version }],
  }));

/** The version a car is on now: the newest release it has installed. */
const currentVersion = (fromDaysAgo, installLagDays) => {
  const seen = RELEASES.filter((r) => r.daysAgo + installLagDays < fromDaysAgo);
  return seen[seen.length - 1].version;
};

/** "HH:MM" from minutes after midnight. */
const clock = (minutes) => {
  if (minutes >= 24 * 60) throw new Error(`demo journey runs past midnight (${minutes} min)`);
  const m = Math.round(minutes);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};
const minutesOf = (hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

/** A stop at a fast charger on the way: the pack topped up to `toSoc`, then on. */
const dc = (place, toSoc = 80, powerKw = 150) => ({ place, toSoc, powerKw, phases: null });
/** Destination charging: a hotel's or a car park's 11 kW AC point, overnight. */
const ac = (place, toSoc = 90, powerKw = 11) => ({ place, toSoc, powerKw, phases: 3 });

/** Time a fast-charge stop takes from plugging in to driving off again. */
const DC_DWELL_MIN = 45;

/**
 * One day's legs: drive, charge, drive on. `legs` are `[route, charge?]` or
 * `[route, charge?, { reverse: true }]`; each drive starts when the one before
 * it and its charging stop are done, so a day never overlaps itself.
 */
function legsFrom(departAt, legs) {
  const events = [];
  let t = minutesOf(departAt);
  for (const [route, charge, options] of legs) {
    events.push({ kind: "drive", route, at: clock(t), ...(options?.reverse ? { reverse: true } : {}) });
    t += ROUTES[route].minutes + 4;
    if (charge) {
      events.push({ kind: "charge", at: clock(t), ...charge });
      t += charge.phases == null ? DC_DWELL_MIN : 0;
    }
  }
  return { events, endsAt: t };
}

/**
 * A trip away: charged full the night before, out in one day of legs, `stay`
 * days parked at the far end, back in another, and an AC top-up at home on
 * arrival. The days away clear the routine — no school run happens from a
 * hotel car park in Kraków.
 */
function journey({ daysAgo, stay, out, back, departAt = "07:30", returnAt = "09:30", chargeAt = "21:50" }) {
  const there = legsFrom(departAt, out);
  const home = legsFrom(returnAt, back);
  return [
    {
      on: { daysAgo: daysAgo + 1 },
      events: [{ kind: "charge", place: "home", at: chargeAt, toSoc: 100, powerKw: 11, phases: 3 }],
    },
    { on: { daysAgo }, clearsDays: stay, events: there.events },
    {
      on: { daysAgo: daysAgo - stay },
      events: [
        ...home.events,
        { kind: "charge", place: "home", at: clock(home.endsAt + 20), toSoc: 80, powerKw: 11, phases: 3 },
      ],
    },
  ];
}

const back = (route, charge) => [route, charge, { reverse: true }];

/**
 * A Leipzig day: charged up the night before, motorway down, a fast charge at
 * the far end, motorway back, and a quiet AC top-up at home.
 */
const leipzigRoundTrip = (daysAgo) => [
  {
    on: { daysAgo: daysAgo + 1 },
    events: [{ kind: "charge", place: "home", at: "21:45", toSoc: 92, powerKw: 11, phases: 3 }],
  },
  {
    on: { daysAgo },
    events: [
      { kind: "drive", route: "leipzigTrip", at: "07:38" },
      { kind: "charge", place: "leipzig", at: "10:05", toSoc: 85, powerKw: 152, phases: null },
      { kind: "drive", route: "leipzigTrip", at: "16:20", reverse: true },
      { kind: "charge", place: "home", at: "21:30", toSoc: 80, powerKw: 11, phases: 3 },
    ],
  },
];

// The trips further afield, about two a year: legs of 120–230 km between
// superchargers, then a hotel's AC point at the far end.
const prague = (daysAgo) =>
  journey({
    daysAgo,
    stay: 4,
    out: [
      ["homeDresden", dc("dresdenSc", 85)],
      ["dresdenPrague", ac("prague")],
    ],
    back: [back("dresdenPrague", dc("dresdenSc", 85)), back("homeDresden")],
  });

const gdansk = (daysAgo) =>
  journey({
    daysAgo,
    stay: 5,
    departAt: "07:00",
    out: [
      ["homeSzczecin", dc("szczecinSc", 85, 120)],
      ["szczecinKoszalin", dc("koszalinSc", 90, 120)],
      ["koszalinGdansk", ac("gdansk")],
    ],
    back: [
      back("koszalinGdansk", dc("koszalinSc", 85, 120)),
      back("szczecinKoszalin", dc("szczecinSc", 85, 120)),
      back("homeSzczecin"),
    ],
    returnAt: "08:30",
  });

const amsterdam = (daysAgo) =>
  journey({
    daysAgo,
    stay: 4,
    departAt: "07:00",
    out: [
      ["homeHelmstedt", dc("helmstedtSc", 85)],
      ["helmstedtOeynhausen", dc("oeynhausenSc", 80)],
      ["oeynhausenHengelo", dc("hengeloSc", 80)],
      ["hengeloAmsterdam", ac("amsterdam")],
    ],
    back: [
      back("hengeloAmsterdam", dc("hengeloSc", 85)),
      back("oeynhausenHengelo", dc("oeynhausenSc", 80)),
      back("helmstedtOeynhausen", dc("helmstedtSc", 85)),
      back("homeHelmstedt"),
    ],
    returnAt: "08:00",
  });

const vienna = (daysAgo) =>
  journey({
    daysAgo,
    stay: 5,
    departAt: "06:45",
    out: [
      ["homeDresden", dc("dresdenSc", 85)],
      ["dresdenPragueSc", dc("pragueSc", 85)],
      ["pragueBrno", dc("brnoSc", 80)],
      ["brnoVienna", ac("vienna")],
    ],
    back: [
      back("brnoVienna", dc("brnoSc", 90)),
      back("pragueBrno", dc("pragueSc", 85)),
      back("dresdenPragueSc", dc("dresdenSc", 85)),
      back("homeDresden"),
    ],
    returnAt: "07:15",
  });

const wroclaw = (daysAgo) =>
  journey({
    daysAgo,
    stay: 2,
    departAt: "08:30",
    out: [
      ["homeCottbus", dc("cottbusSc", 95)],
      ["cottbusWroclaw", ac("wroclaw", 100)],
    ],
    back: [back("cottbusWroclaw", dc("cottbusSc", 75)), back("homeCottbus")],
    returnAt: "11:00",
  });

const krakow = (daysAgo) =>
  journey({
    daysAgo,
    stay: 4,
    departAt: "07:00",
    out: [
      ["homeCottbus", dc("cottbusSc", 95)],
      ["cottbusWroclawSc", dc("wroclawSc", 85, 120)],
      ["wroclawGliwice", dc("gliwiceSc", 75, 120)],
      ["gliwiceKrakow", ac("krakow")],
    ],
    back: [
      back("gliwiceKrakow", dc("gliwiceSc", 85, 120)),
      back("wroclawGliwice", dc("wroclawSc", 95, 120)),
      back("cottbusWroclawSc", dc("cottbusSc", 75)),
      back("homeCottbus"),
    ],
    returnAt: "08:00",
  });

/** The Model Y's summer weeks: the Baltic, both sides of the border. */
const baltic = (daysAgo) =>
  journey({
    daysAgo,
    stay: 7,
    departAt: "09:10",
    // Plugged in after the evening's routine top-up has finished.
    chargeAt: "22:30",
    out: [["balticTrip", ac("rostock")]],
    back: [["rostockNeuruppin", dc("neuruppin", 75, 168)], ["neuruppinHome"]],
    returnAt: "10:20",
  });

const kolobrzeg = (daysAgo) =>
  journey({
    daysAgo,
    stay: 7,
    departAt: "08:45",
    chargeAt: "22:30",
    out: [
      ["homeSzczecin", dc("szczecinSc", 85, 120)],
      ["szczecinKolobrzeg", ac("kolobrzeg")],
    ],
    back: [back("szczecinKolobrzeg", dc("szczecinSc", 80, 120)), back("homeSzczecin")],
    returnAt: "10:00",
  });

/**
 * A Sunday out of town: topped up on the wallbox first thing when the round
 * trip is a long one, out late morning, back for dinner.
 */
const sundayOut = (
  route,
  weekOffset,
  { everyNthWeek, fromDaysAgo, out = "10:40", home = "16:30", charge = false },
) => ({
  repeat: { fromDaysAgo, toDaysAgo: 1, weekdays: [0], everyNthWeek, weekOffset },
  events: [
    ...(charge ? [{ kind: "charge", place: "home", at: "07:00", toSoc: 90, powerKw: 11, phases: 3 }] : []),
    { kind: "drive", route, at: out },
    { kind: "drive", route, at: home, reverse: true },
  ],
});

/**
 * A day the logger was half blind: the morning commute began before the first
 * sample (a bounded start), then the car dropped offline at the office, and the
 * drive home and the night's charge happened while nobody could read it. The
 * app shows them as reconstructed — "Happened between …", no duration — from
 * what the odometer and the state of charge say.
 */
const blindDay = (daysAgo) => ({
  on: { daysAgo },
  events: [
    { kind: "drive", route: "commute", at: "08:12", wakeMin: 6 },
    { kind: "drive", route: "commute", at: "17:41", reverse: true, hidden: { beforeMin: 95, afterMin: 40 } },
    {
      kind: "charge",
      place: "home",
      at: "22:05",
      toSoc: 80,
      powerKw: 11,
      phases: 3,
      hidden: { beforeMin: 30, afterMin: 300 },
    },
  ],
});

/**
 * Car one: the 2019 Model 3 that commutes. Three years of history — the pack
 * was four years old when the log starts, so its fade curve is already on the
 * flat part, and the health page reads about 91% against the VIN's 74 kWh.
 */
const MODEL_3 = {
  id: 1,
  eid: 99_000_000_001,
  vid: 1_492_000_001,
  vin: "5YJ3E1EB6KF999999",
  name: "Ampere",
  model: "3",
  carType: "model3",
  trimBadging: "74d",
  marketingName: "Model 3 Long Range",
  exteriorColor: "DeepBlue",
  wheelType: "Pinwheel18",
  spoilerType: "None",
  efficiency: 0.153,
  /** Usable when new, per the VIN; the fade curve hangs off this. */
  capacityKwh: 74,
  fade: { kwhPerSqrtDay: 0.13, priorDays: 1460 },
  climate: BERLIN_CLIMATE,
  seed: 20_230_811,
  startOdometerKm: 68_412.7,
  startSoc: 72,
  schedule: [
    {
      // Three years of office life, down Prenzlauer Allee on Mondays,
      // Wednesdays and Fridays and across on Torstraße the other days, and a
      // top-up at home every other night.
      repeat: { fromDaysAgo: 1085, toDaysAgo: 1, weekdays: [1, 3, 5] },
      events: [
        { kind: "drive", route: "commute", at: "08:12" },
        { kind: "drive", route: "commute", at: "17:41", reverse: true },
        { kind: "charge", place: "home", at: "22:05", toSoc: 80, powerKw: 11, phases: 3, everyNthDay: 2 },
      ],
    },
    {
      repeat: { fromDaysAgo: 1085, toDaysAgo: 1, weekdays: [2, 4] },
      events: [
        { kind: "drive", route: "commuteAlt", at: "08:05" },
        { kind: "drive", route: "commuteAlt", at: "17:52", reverse: true },
        { kind: "charge", place: "home", at: "22:05", toSoc: 80, powerKw: 11, phases: 3, everyNthDay: 2 },
      ],
    },
    {
      // Every other Thursday, dinner with friends in Neukölln.
      repeat: { fromDaysAgo: 1085, toDaysAgo: 1, weekdays: [4], everyNthWeek: 2 },
      events: [
        { kind: "drive", route: "friends", at: "19:05" },
        { kind: "drive", route: "friends", at: "21:20", reverse: true },
      ],
    },
    {
      // Someone to collect from BER every couple of months.
      repeat: { fromDaysAgo: 1085, toDaysAgo: 1, weekdays: [5], everyNthWeek: 7, weekOffset: 3 },
      events: [
        { kind: "drive", route: "airport", at: "18:40" },
        { kind: "drive", route: "airport", at: "20:05", reverse: true },
      ],
    },
    {
      // Saturday market run.
      repeat: { fromDaysAgo: 1085, toDaysAgo: 1, weekdays: [6] },
      events: [
        { kind: "drive", route: "groceries", at: "10:24" },
        { kind: "drive", route: "groceries", at: "11:38", reverse: true },
      ],
    },
    {
      // And in the afternoon, in rotation: the big shop with a charge on the
      // supermarket's posts, IKEA, the mall.
      repeat: { fromDaysAgo: 1085, toDaysAgo: 1, weekdays: [6], everyNthWeek: 3, weekOffset: 1 },
      events: [
        { kind: "drive", route: "kaufland", at: "14:30" },
        { kind: "charge", place: "kaufland", at: "14:42", toSoc: 80, powerKw: 22, phases: 3 },
        { kind: "drive", route: "kaufland", at: "16:15", reverse: true },
      ],
    },
    {
      repeat: { fromDaysAgo: 1085, toDaysAgo: 1, weekdays: [6], everyNthWeek: 6 },
      events: [
        { kind: "drive", route: "ikea", at: "14:10" },
        { kind: "drive", route: "ikea", at: "16:40", reverse: true },
      ],
    },
    {
      repeat: { fromDaysAgo: 1085, toDaysAgo: 1, weekdays: [6], everyNthWeek: 6, weekOffset: 3 },
      events: [
        { kind: "drive", route: "mall", at: "15:00" },
        { kind: "drive", route: "mall", at: "16:50", reverse: true },
      ],
    },
    {
      // Every other Sunday, a day out of town; at the lake it comes home by
      // way of the office, whose charger is cheaper than the wallbox.
      repeat: { fromDaysAgo: 1085, toDaysAgo: 1, weekdays: [0], everyNthWeek: 12 },
      events: [
        { kind: "drive", route: "lake", at: "11:02" },
        { kind: "drive", route: "lakeOffice", at: "17:24" },
        { kind: "charge", place: "office", at: "18:05", toSoc: 75, powerKw: 11, phases: 3 },
        { kind: "drive", route: "commute", at: "20:40", reverse: true },
      ],
    },
    sundayOut("potsdam", 2, { everyNthWeek: 12, fromDaysAgo: 1085 }),
    sundayOut("brandenburg", 4, { everyNthWeek: 12, fromDaysAgo: 1085, charge: true }),
    sundayOut("lake", 6, { everyNthWeek: 12, fromDaysAgo: 1085, out: "11:10", home: "17:40" }),
    sundayOut("chorin", 8, { everyNthWeek: 12, fromDaysAgo: 1085, charge: true }),
    sundayOut("saarow", 10, { everyNthWeek: 12, fromDaysAgo: 1085, charge: true }),
    // Roughly quarterly Leipzig runs — DC charging in every season, which is
    // what gives the charging-curve and AC-vs-DC screens their content.
    ...leipzigRoundTrip(1044),
    ...leipzigRoundTrip(968),
    ...leipzigRoundTrip(855),
    ...leipzigRoundTrip(761),
    ...leipzigRoundTrip(664),
    ...leipzigRoundTrip(570),
    ...leipzigRoundTrip(458),
    ...leipzigRoundTrip(352),
    ...leipzigRoundTrip(247),
    ...leipzigRoundTrip(141),
    ...leipzigRoundTrip(47),
    // And about twice a year, somewhere further: early spring, high summer.
    ...prague(985),
    ...gdansk(838),
    ...amsterdam(600),
    ...vienna(480),
    ...wroclaw(215),
    ...krakow(165),
    // Outages: a lapsed token, a router swapped at the office, a deploy gone wrong.
    blindDay(234),
    blindDay(61),
    blindDay(3),
    {
      // A recent supercharger stop, so "Last 30 days" has fast charging too.
      on: { daysAgo: 5 },
      events: [
        { kind: "drive", route: "supercharger", at: "18:35" },
        { kind: "charge", place: "supercharger", at: "19:05", toSoc: 85, powerKw: 118, phases: null },
        { kind: "drive", route: "supercharger", at: "19:55", reverse: true },
      ],
    },
    ...updateEvents(1085, 3),
  ],
  live: {
    place: "home",
    scenario: "parked",
    outsideTempC: 24,
    insideTempC: 27,
    // The rear left has a slow leak — a nail, three weeks in — and now sits
    // well under the 2.9 bar the car recommends, which is what the Health
    // page's tyre tile and the nav's attention dot are there to show.
    tyrePressureBar: { fl: 2.85, fr: 2.9, rl: 2.42, rr: 2.88 },
    softwareVersion: currentVersion(1085, 3),
  },
  tyres: {
    recommendedBar: { front: 2.9, rear: 2.9 },
    fillEveryDays: 90,
    lastFillDaysAgo: 26,
    leak: { corner: "rl", startDaysAgo: 21, totalBar: 0.46 },
  },
};

/**
 * Car two: the 2022 Model Y that does the family duty. Two years of history —
 * short school runs, the weekly swim, and a Baltic holiday every summer.
 */
const MODEL_Y = {
  id: 2,
  eid: 99_000_000_002,
  vid: 1_492_000_002,
  vin: "XP7YGDEKXNB123456",
  name: "Watt",
  model: "Y",
  carType: "modely",
  trimBadging: "74d",
  marketingName: "Model Y Long Range",
  exteriorColor: "PearlWhite",
  wheelType: "Apollo19",
  spoilerType: "None",
  efficiency: 0.163,
  capacityKwh: 75,
  fade: { kwhPerSqrtDay: 0.155, priorDays: 715 },
  climate: BERLIN_CLIMATE,
  seed: 20_240_812,
  startOdometerKm: 24_318.4,
  startSoc: 64,
  schedule: [
    {
      // The school run, there and back, every weekday.
      repeat: { fromDaysAgo: 725, toDaysAgo: 1, weekdays: [1, 2, 3, 4, 5] },
      events: [
        { kind: "drive", route: "schoolRun", at: "07:52" },
        { kind: "drive", route: "schoolRun", at: "15:36", reverse: true },
        { kind: "charge", place: "home", at: "20:40", toSoc: 80, powerKw: 11, phases: 3, everyNthDay: 3 },
      ],
    },
    {
      // Tuesday is music school up in Pankow.
      repeat: { fromDaysAgo: 725, toDaysAgo: 1, weekdays: [2] },
      events: [
        { kind: "drive", route: "musicSchool", at: "16:20" },
        { kind: "drive", route: "musicSchool", at: "17:35", reverse: true },
      ],
    },
    {
      // Wednesday evening at the pool.
      repeat: { fromDaysAgo: 725, toDaysAgo: 1, weekdays: [3] },
      events: [
        { kind: "drive", route: "gym", at: "18:05" },
        { kind: "drive", route: "gym", at: "19:55", reverse: true },
      ],
    },
    {
      // Saturdays now and then: the zoo in the east, the mall in the north.
      repeat: { fromDaysAgo: 725, toDaysAgo: 1, weekdays: [6], everyNthWeek: 4 },
      events: [
        { kind: "drive", route: "tierpark", at: "10:15" },
        { kind: "drive", route: "tierpark", at: "14:20", reverse: true },
      ],
    },
    {
      repeat: { fromDaysAgo: 725, toDaysAgo: 1, weekdays: [6], everyNthWeek: 4, weekOffset: 2 },
      events: [
        { kind: "drive", route: "mall", at: "11:00" },
        { kind: "drive", route: "mall", at: "12:45", reverse: true },
      ],
    },
    {
      // Sunday lunch at the grandparents' every other week …
      repeat: { fromDaysAgo: 725, toDaysAgo: 1, weekdays: [0], everyNthWeek: 2 },
      events: [
        { kind: "drive", route: "grandparents", at: "12:10" },
        { kind: "drive", route: "grandparents", at: "17:20", reverse: true },
      ],
    },
    // … and a lake on the Sundays between.
    sundayOut("liepnitzsee", 1, { everyNthWeek: 4, fromDaysAgo: 725 }),
    sundayOut("muggelsee", 3, { everyNthWeek: 4, fromDaysAgo: 725, out: "10:30", home: "16:10" }),
    {
      // The pack gets a fuller charge once a month, which is the spread the
      // capacity fit needs.
      repeat: { fromDaysAgo: 725, toDaysAgo: 1, weekdays: [0], everyNthWeek: 4 },
      events: [{ kind: "charge", place: "home", at: "19:30", toSoc: 90, powerKw: 11, phases: 3 }],
    },
    {
      // The occasional city supercharge when the calendar wins over the wallbox.
      repeat: { fromDaysAgo: 725, toDaysAgo: 10, weekdays: [5], everyNthWeek: 6 },
      events: [
        { kind: "drive", route: "supercharger", at: "16:20" },
        { kind: "charge", place: "supercharger", at: "16:50", toSoc: 80, powerKw: 122, phases: null },
        { kind: "drive", route: "supercharger", at: "17:40", reverse: true },
      ],
    },
    // Two summers, two weeks by the sea.
    ...kolobrzeg(490),
    ...baltic(128),
    ...updateEvents(725, 9),
  ],
  live: {
    place: "home",
    scenario: "parked",
    outsideTempC: 24,
    insideTempC: 26,
    tyrePressureBar: { fl: 2.95, fr: 2.92, rl: 2.9, rr: 2.93 },
    softwareVersion: currentVersion(725, 9),
  },
  // No leak: four tyres that only breathe with the seasons and the fills.
  tyres: { recommendedBar: { front: 2.9, rear: 2.9 }, fillEveryDays: 120, lastFillDaysAgo: 40 },
};

export const WORLD = {
  timezone: TIMEZONE,
  places: PLACES,
  routes: ROUTES,
  thinning: THINNING,
  sampling: SAMPLING,
  // A phone-grade GPS fix: a few metres either way, not the e2e world's thirty.
  gpsJitterDeg: 0.00004,
  // Some mornings the car is woken and driven off before the poller's first
  // sample: those drives start at the parked spot, at a bounded time.
  wakeStarts: { percent: 15 },
  cars: [MODEL_3, MODEL_Y],
};
