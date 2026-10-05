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
 * Days are relative to the seed moment, so the history always ends "now".
 */

const TIMEZONE = "Europe/Berlin";

/** Berlin's year: mean ~10.5 °C, ±9.5 °C over the seasons, coldest late January. */
const BERLIN_CLIMATE = { meanC: 10.5, amplitudeC: 9.5, coldestDayOfYear: 25, diurnalC: 6 };

/** Old drives keep a sketch of their track; recent ones stay chart-dense. */
const THINNING = { afterDays: 120, driveSamples: 8 };

const PLACES = {
  home: {
    name: "Home",
    lat: 52.5399,
    lon: 13.4232,
    fence: { radius: 120, billing: "per_kwh", rate: 0.29, sessionFeeCents: 0 },
    address: { road: "Greifswalder Straße", houseNumber: "212", city: "Berlin", postcode: "10405" },
  },
  office: {
    name: "Office",
    lat: 52.5074,
    lon: 13.3904,
    fence: { radius: 150, billing: "per_kwh", rate: 0.19, sessionFeeCents: 0 },
    address: { road: "Leipziger Straße", houseNumber: "126", city: "Berlin", postcode: "10117" },
  },
  school: {
    name: "Grundschule am Kollwitzplatz",
    lat: 52.5372,
    lon: 13.4166,
    address: { road: "Knaackstraße", houseNumber: "67", city: "Berlin", postcode: "10435" },
  },
  gym: {
    name: "Schwimmhalle Ernst-Thälmann-Park",
    lat: 52.5289,
    lon: 13.4444,
    address: { road: "Lilli-Henoch-Straße", houseNumber: "20", city: "Berlin", postcode: "10405" },
  },
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
  supercharger: {
    name: "Supercharger Tempelhof",
    lat: 52.4771,
    lon: 13.4394,
    fence: { radius: 200, billing: "per_kwh", rate: 0.55, sessionFeeCents: 99 },
    address: { road: "Tempelhofer Damm", houseNumber: "227", city: "Berlin", postcode: "12099" },
  },
  leipzig: {
    name: "Supercharger Leipzig Nord",
    lat: 51.3397,
    lon: 12.3731,
    fence: { radius: 250, billing: "per_kwh", rate: 0.61, sessionFeeCents: 0 },
    address: { road: "Maximilianallee", houseNumber: "4", city: "Leipzig", postcode: "04129", state: "Sachsen" },
  },
  neuruppin: {
    name: "Supercharger Neuruppin",
    lat: 52.9236,
    lon: 12.8034,
    fence: { radius: 220, billing: "per_kwh", rate: 0.52, sessionFeeCents: 0 },
    address: { road: "An der B167", houseNumber: "2", city: "Neuruppin", postcode: "16816", state: "Brandenburg" },
  },
  rostock: {
    name: "Strandhotel Warnemünde",
    lat: 54.1766,
    lon: 12.0806,
    fence: { radius: 180, billing: "per_kwh", rate: 0.49, sessionFeeCents: 200 },
    address: { road: "Seestraße", houseNumber: "12", city: "Rostock", postcode: "18119", state: "Mecklenburg-Vorpommern" },
  },
};

const ROUTES = {
  commute: {
    from: "home",
    to: "office",
    km: 9.6,
    minutes: 24,
    maxKmh: 68,
    waypoints: [
      [52.5399, 13.4232],
      [52.5301, 13.4102],
      [52.5215, 13.4014],
      [52.5142, 13.3958],
      [52.5074, 13.3904],
    ],
  },
  schoolRun: {
    from: "home",
    to: "school",
    km: 2.1,
    minutes: 9,
    maxKmh: 38,
    waypoints: [
      [52.5399, 13.4232],
      [52.5386, 13.4198],
      [52.5372, 13.4166],
    ],
  },
  gym: {
    from: "home",
    to: "gym",
    km: 3.8,
    minutes: 12,
    maxKmh: 44,
    waypoints: [
      [52.5399, 13.4232],
      [52.5341, 13.4336],
      [52.5289, 13.4444],
    ],
  },
  groceries: {
    from: "home",
    to: "market",
    km: 3.1,
    minutes: 11,
    maxKmh: 42,
    waypoints: [
      [52.5399, 13.4232],
      [52.5377, 13.4211],
      [52.5354, 13.4187],
    ],
  },
  lake: {
    from: "home",
    to: "lakeside",
    km: 29.4,
    minutes: 41,
    maxKmh: 106,
    waypoints: [
      [52.5399, 13.4232],
      [52.5011, 13.3419],
      [52.4762, 13.2861],
      [52.4519, 13.2214],
      [52.4325, 13.1745],
    ],
  },
  // Berlin to Leipzig down the A9, motorway speeds all the way.
  leipzigTrip: {
    from: "home",
    to: "leipzig",
    km: 189.2,
    minutes: 121,
    maxKmh: 143,
    waypoints: [
      [52.5399, 13.4232],
      [52.4103, 13.2216],
      [52.3018, 13.0281],
      [51.8877, 12.4443],
      [51.6236, 12.3169],
      [51.3397, 12.3731],
    ],
  },
  // The holiday leg north: Berlin to the Baltic on the A19.
  balticTrip: {
    from: "home",
    to: "rostock",
    km: 232.6,
    minutes: 148,
    maxKmh: 138,
    waypoints: [
      [52.5399, 13.4232],
      [52.6748, 13.2611],
      [52.9236, 12.8034],
      [53.3123, 12.4122],
      [53.7614, 12.1731],
      [54.1766, 12.0806],
    ],
  },
  // The stretch from the Neuruppin charger home, for the broken-up return leg.
  neuruppinHome: {
    from: "neuruppin",
    to: "home",
    km: 82.4,
    minutes: 58,
    maxKmh: 132,
    waypoints: [
      [52.9236, 12.8034],
      [52.7411, 13.0122],
      [52.6236, 13.2214],
      [52.5399, 13.4232],
    ],
  },
  // And the long half of that return: hotel to the Neuruppin charger.
  rostockNeuruppin: {
    from: "rostock",
    to: "neuruppin",
    km: 151.8,
    minutes: 96,
    maxKmh: 136,
    waypoints: [
      [54.1766, 12.0806],
      [53.7614, 12.1731],
      [53.3123, 12.4122],
      [52.9236, 12.8034],
    ],
  },
};

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

/**
 * A Leipzig round trip: charged up the night before, motorway down, a DC fast
 * charge at the far end, motorway back, and a quiet AC top-up at home.
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

/**
 * The summer holiday at the Baltic: up in one hop, destination charging at the
 * hotel, and a return broken at the Neuruppin supercharger.
 */
const balticHoliday = (departDaysAgo) => [
  {
    on: { daysAgo: departDaysAgo + 1 },
    events: [{ kind: "charge", place: "home", at: "20:30", toSoc: 100, powerKw: 11, phases: 3 }],
  },
  {
    on: { daysAgo: departDaysAgo },
    // The week at the sea clears the routine: no school runs happen from a
    // hotel car park three hundred kilometres north of the school.
    clearsDays: 7,
    events: [
      { kind: "drive", route: "balticTrip", at: "09:10" },
      { kind: "charge", place: "rostock", at: "13:40", toSoc: 90, powerKw: 11, phases: 3 },
    ],
  },
  {
    on: { daysAgo: departDaysAgo - 7 },
    events: [
      { kind: "drive", route: "rostockNeuruppin", at: "10:20" },
      { kind: "charge", place: "neuruppin", at: "12:15", toSoc: 75, powerKw: 168, phases: null },
      { kind: "drive", route: "neuruppinHome", at: "13:05" },
      { kind: "charge", place: "home", at: "19:40", toSoc: 80, powerKw: 11, phases: 3 },
    ],
  },
];

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
      // Three years of office life: out in the morning, back in the evening,
      // and a top-up at home every other night.
      repeat: { fromDaysAgo: 1085, toDaysAgo: 1, weekdays: [1, 2, 3, 4, 5] },
      events: [
        { kind: "drive", route: "commute", at: "08:12" },
        { kind: "drive", route: "commute", at: "17:41", reverse: true },
        { kind: "charge", place: "home", at: "22:05", toSoc: 80, powerKw: 11, phases: 3, everyNthDay: 2 },
      ],
    },
    {
      // Saturday market run, then a slow top-up off the granny charger.
      repeat: { fromDaysAgo: 1085, toDaysAgo: 1, weekdays: [6] },
      events: [
        { kind: "drive", route: "groceries", at: "10:24" },
        { kind: "drive", route: "groceries", at: "11:38", reverse: true },
        { kind: "charge", place: "home", at: "13:10", toSoc: 70, powerKw: 3.7, phases: 1 },
      ],
    },
    {
      // Every other Sunday at the lake, charging at the office on the way back
      // because it is cheaper than home.
      repeat: { fromDaysAgo: 1085, toDaysAgo: 1, weekdays: [0], everyNthWeek: 2 },
      events: [
        { kind: "drive", route: "lake", at: "11:02" },
        { kind: "drive", route: "lake", at: "17:24", reverse: true },
        { kind: "charge", place: "office", at: "18:20", toSoc: 75, powerKw: 11, phases: 3 },
      ],
    },
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
    {
      // A recent supercharger stop, so "Last 30 days" has fast charging too.
      on: { daysAgo: 5 },
      events: [{ kind: "charge", place: "supercharger", at: "19:05", toSoc: 85, powerKw: 118, phases: null }],
    },
    ...updateEvents(1085, 3),
  ],
  live: {
    place: "home",
    scenario: "parked",
    outsideTempC: 24,
    insideTempC: 27,
    tyrePressureBar: { fl: 2.85, fr: 2.9, rl: 2.86, rr: 2.88 },
    softwareVersion: currentVersion(1085, 3),
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
      // Wednesday evening at the pool.
      repeat: { fromDaysAgo: 725, toDaysAgo: 1, weekdays: [3] },
      events: [
        { kind: "drive", route: "gym", at: "18:05" },
        { kind: "drive", route: "gym", at: "19:55", reverse: true },
      ],
    },
    {
      // A proper Sunday outing most weeks; the pack gets a fuller charge for it
      // once a month, which is the spread the capacity fit needs.
      repeat: { fromDaysAgo: 725, toDaysAgo: 1, weekdays: [0] },
      events: [
        { kind: "drive", route: "lake", at: "10:40" },
        { kind: "drive", route: "lake", at: "16:50", reverse: true },
      ],
    },
    {
      repeat: { fromDaysAgo: 725, toDaysAgo: 1, weekdays: [0], everyNthWeek: 4 },
      events: [{ kind: "charge", place: "home", at: "19:30", toSoc: 90, powerKw: 11, phases: 3 }],
    },
    {
      // The occasional city supercharge when the calendar wins over the wallbox.
      repeat: { fromDaysAgo: 725, toDaysAgo: 10, weekdays: [5], everyNthWeek: 6 },
      events: [{ kind: "charge", place: "supercharger", at: "16:45", toSoc: 80, powerKw: 122, phases: null }],
    },
    // Two summers, two Baltic holidays.
    ...balticHoliday(388),
    ...balticHoliday(26),
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
};

export const WORLD = {
  timezone: TIMEZONE,
  places: PLACES,
  routes: ROUTES,
  thinning: THINNING,
  cars: [MODEL_3, MODEL_Y],
};
