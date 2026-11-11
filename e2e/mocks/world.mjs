/**
 * THE MOCK WORLD — this is the file you edit to change what the test suite sees.
 *
 * Everything is declarative. `generate.mjs` turns it into a coherent history by
 * simulating the car chronologically: odometer, state of charge, range and
 * battery capacity all carry over from one event to the next, so the seeded
 * database looks like something that actually happened.
 *
 * Times are wall-clock in the world's time zone. Days are relative to the seed
 * moment ("now"), so the data always lands inside the app's date filters.
 */

export const TIMEZONE = "Europe/Berlin";

export const CAR = {
  id: 1,
  eid: 99_000_000_001,
  vid: 1_492_000_001,
  // Position 8 `B`: a dual-motor Long Range, matching the 75 kWh pack and the
  // `74d` trim below — the health page compares measured capacity against what
  // the VIN says the pack held when new, so the two must tell one story.
  vin: "5YJ3E1EB6KF999999",
  name: "Fixture Bro",
  /** The letter the app derives from car_type — what it stores in the cars table. */
  model: "3",
  carType: "model3",
  trimBadging: "74d",
  marketingName: "Model 3 Long Range",
  exteriorColor: "DeepBlue",
  wheelType: "Pinwheel18",
  spoilerType: "None",
  /** kWh per km of rated range — the factor the app derives energy with. */
  efficiency: 0.153,
  /** Usable pack size when new, and how much it fades per day of the history. */
  capacityKwh: 75.0,
  capacityFadePerDay: 0.0125,
  /**
   * The rear left has been losing air for two and a half weeks: the tyre tile
   * reads it low against the car's 2.9 bar, the car itself has raised its soft
   * warning, and the nav carries the attention dot (see tyres.mjs).
   */
  tyres: {
    recommendedBar: { front: 2.9, rear: 2.9 },
    fillEveryDays: 90,
    lastFillDaysAgo: 20,
    leak: { corner: "rl", startDaysAgo: 18, totalBar: 0.45 },
  },
};

/**
 * Named places. `fence` gives the place a geo-fence (so it shows up by name and
 * can price charging); `address` is the reverse-geocoded street address that the
 * mock Nominatim serves for coordinates nearby.
 */
export const PLACES = {
  home: {
    name: "Home",
    lat: 52.5266,
    lon: 13.411,
    fence: { radius: 120, billing: "per_kwh", rate: 0.28, sessionFeeCents: 0 },
    address: { road: "Torstraße", houseNumber: "1", city: "Berlin", postcode: "10119" },
  },
  office: {
    name: "Office",
    lat: 52.5096,
    lon: 13.376,
    fence: { radius: 150, billing: "per_kwh", rate: 0.19, sessionFeeCents: 0 },
    address: { road: "Potsdamer Platz", houseNumber: "1", city: "Berlin", postcode: "10785" },
  },
  supercharger: {
    name: "Supercharger Tempelhof",
    lat: 52.4771,
    lon: 13.4394,
    fence: { radius: 200, billing: "per_kwh", rate: 0.55, sessionFeeCents: 99 },
    address: { road: "Tempelhofer Damm", houseNumber: "227", city: "Berlin", postcode: "12099" },
  },
  // No fence — exercises the address-only label path in the drives table.
  market: {
    name: "Wochenmarkt Kollwitzplatz",
    lat: 52.5354,
    lon: 13.4187,
    address: { road: "Kollwitzstraße", houseNumber: "66", city: "Berlin", postcode: "10435" },
  },
  lakeside: {
    name: "Strandbad Wannsee",
    lat: 52.4325,
    lon: 13.1745,
    address: { road: "Wannseebadweg", houseNumber: "25", city: "Berlin", postcode: "14129" },
  },
  leipzig: {
    name: "Supercharger Leipzig Nord",
    lat: 51.3397,
    lon: 12.3731,
    fence: { radius: 250, billing: "per_kwh", rate: 0.61, sessionFeeCents: 0 },
    address: { road: "Maximilianallee", houseNumber: "4", city: "Leipzig", postcode: "04129" },
  },
};

/**
 * Routes are a handful of waypoints plus a driving character; the generator
 * interpolates the samples that the route map and the detail charts draw.
 */
export const ROUTES = {
  commute: {
    from: "home",
    to: "office",
    km: 11.8,
    minutes: 26,
    maxKmh: 74,
    waypoints: [
      [52.5266, 13.411],
      [52.5231, 13.4048],
      [52.5182, 13.3951],
      [52.5138, 13.3861],
      [52.5096, 13.376],
    ],
  },
  groceries: {
    from: "home",
    to: "market",
    km: 3.4,
    minutes: 11,
    maxKmh: 46,
    waypoints: [
      [52.5266, 13.411],
      [52.5301, 13.4142],
      [52.5354, 13.4187],
    ],
  },
  lake: {
    from: "home",
    to: "lakeside",
    km: 27.6,
    minutes: 38,
    maxKmh: 108,
    waypoints: [
      [52.5266, 13.411],
      [52.5011, 13.3419],
      [52.4762, 13.2861],
      [52.4519, 13.2214],
      [52.4325, 13.1745],
    ],
  },
  // The road trip: Berlin to Leipzig down the A9, motorway speeds all the way.
  roadTrip: {
    from: "home",
    to: "leipzig",
    km: 186.4,
    minutes: 118,
    maxKmh: 143,
    waypoints: [
      [52.5266, 13.411],
      [52.4103, 13.2216],
      [52.3018, 13.0281],
      [51.8877, 12.4443],
      [51.6236, 12.3169],
      [51.3397, 12.3731],
    ],
  },
};

/**
 * What happened, oldest first. Each entry is either a one-off (`on`) or a
 * recurring pattern (`repeat`). Event kinds:
 *
 *   drive  { route, at, reverse?, temp?, wakeMin?, hidden? }
 *   charge { place, at, toSoc, powerKw, phases?, minutes?, hidden? }  phases: null = DC
 *   update { at, version }
 *
 * `phases: null` marks a DC fast charge, which is how the app tells AC from DC.
 *
 * `wakeMin` makes a drive one the car woke into and pulled away on unseen: its
 * start is a span reaching that many minutes back. `hidden: { beforeMin,
 * afterMin }` makes the event one nobody saw — the car offline from `beforeMin`
 * before it until `afterMin` after — so the logger has only the readings either
 * side and records it as reconstructed.
 */
export const SCHEDULE = [
  {
    // Ten weeks of office life: out in the morning, back in the evening, and a
    // top-up at home on most nights.
    repeat: { fromDaysAgo: 70, toDaysAgo: 1, weekdays: [1, 2, 3, 4, 5] },
    events: [
      { kind: "drive", route: "commute", at: "08:12" },
      { kind: "drive", route: "commute", at: "17:41", reverse: true },
      { kind: "charge", place: "home", at: "22:05", toSoc: 80, powerKw: 11, phases: 3, everyNthDay: 2 },
    ],
  },
  {
    // Saturday market run, then the battery gets a slow top-up.
    repeat: { fromDaysAgo: 70, toDaysAgo: 1, weekdays: [6] },
    events: [
      { kind: "drive", route: "groceries", at: "10:24" },
      { kind: "drive", route: "groceries", at: "11:38", reverse: true },
      { kind: "charge", place: "home", at: "13:10", toSoc: 70, powerKw: 3.7, phases: 1 },
    ],
  },
  {
    // A hot Sunday at the lake, charging at the office on the way back because
    // it is cheaper than home.
    repeat: { fromDaysAgo: 70, toDaysAgo: 1, weekdays: [0], everyNthWeek: 2 },
    events: [
      { kind: "drive", route: "lake", at: "11:02", temp: 27.5 },
      { kind: "drive", route: "lake", at: "17:24", reverse: true, temp: 29 },
      { kind: "charge", place: "office", at: "18:20", toSoc: 75, powerKw: 11, phases: 3 },
    ],
  },
  {
    // Charged to 90% the night before the trip, the way anyone would.
    on: { daysAgo: 10 },
    events: [{ kind: "charge", place: "home", at: "22:30", toSoc: 90, powerKw: 11, phases: 3 }],
  },
  {
    // The road trip: motorway speeds and a DC fast charge, which is what the
    // charging-curve and AC-vs-DC screens are there to show.
    on: { daysAgo: 9 },
    events: [
      { kind: "drive", route: "roadTrip", at: "07:38", temp: 14 },
      { kind: "charge", place: "leipzig", at: "10:05", toSoc: 78, powerKw: 152, phases: null },
      { kind: "drive", route: "roadTrip", at: "16:20", reverse: true, temp: 21 },
      { kind: "charge", place: "home", at: "21:30", toSoc: 80, powerKw: 11, phases: 3 },
    ],
  },
  {
    // A day the logger was half blind: the morning commute began before the
    // first sample (a bounded start), and the car then went offline at the
    // office — the drive home and the night's charge happened while nobody
    // could read it, and are what the odometer and the state of charge say.
    on: { daysAgo: 5 },
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
  },
  {
    // One more DC session, close to now, so "Last 30 days" has fast charging.
    on: { daysAgo: 3 },
    events: [{ kind: "charge", place: "supercharger", at: "19:05", toSoc: 85, powerKw: 118, phases: null }],
  },
  { on: { daysAgo: 44 }, events: [{ kind: "update", at: "03:12", version: "2026.8.4 c0f1a9d" }] },
  { on: { daysAgo: 12 }, events: [{ kind: "update", at: "02:48", version: "2026.14.3 f9a1c2b" }] },
];

/** Where the car is sitting, and what it is doing, when the tests start. */
export const LIVE = {
  place: "home",
  scenario: "parked",
  outsideTempC: 17.5,
  insideTempC: 22,
  tyrePressureBar: { fl: 2.85, fr: 2.9, rl: 2.4, rr: 2.88 },
  softwareVersion: "2026.14.3 f9a1c2b",
};
