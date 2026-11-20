/**
 * Where the demo household goes: the places it stops at and the routes between
 * them, as specs. The road geometry of every route lives in `routes.json`,
 * fetched once from OSRM by `demo/fetch-routes.mjs` and committed, so seeding
 * never touches the network (the VPS reseeds nightly with node builtins only).
 *
 * Change a place or a route here and re-run
 *
 *   bun demo/fetch-routes.mjs
 *
 * which refetches only the routes whose ends or vias moved.
 */

/** A public charger: priced per kWh, wide enough a fence to catch the bay. */
const charger = (rate, sessionFeeCents = 0, radius = 220) => ({ radius, billing: "per_kwh", rate, sessionFeeCents });

export const PLACES = {
  // ── Berlin ──────────────────────────────────────────────────────────────
  home: {
    name: "Home",
    lat: 52.5399,
    lon: 13.4232,
    // A two-rate household tariff: the wallbox charges at night for less, and
    // the 11 kW it delivers bounds how much any hour can take.
    fence: {
      radius: 120,
      billing: "per_kwh",
      rate: 0.36,
      sessionFeeCents: 0,
      chargerPowerKw: 11,
      windows: [
        { label: "Night", days: [1, 2, 3, 4, 5, 6, 7], start: "22:00", end: "06:00", months: null, rate: 0.24 },
      ],
    },
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
  musicSchool: {
    name: "Musikschule Pankow",
    lat: 52.5703,
    lon: 13.4087,
    address: { road: "Breite Straße", houseNumber: "2", city: "Berlin", postcode: "13187" },
  },
  grandparents: {
    name: "Oma & Opa",
    lat: 52.4561,
    lon: 13.3218,
    address: { road: "Grunewaldstraße", houseNumber: "41", city: "Berlin", postcode: "12165" },
  },
  friends: {
    name: "Weserstraße",
    lat: 52.4866,
    lon: 13.4339,
    address: { road: "Weserstraße", houseNumber: "58", city: "Berlin", postcode: "12045" },
  },
  ikea: {
    name: "IKEA Lichtenberg",
    lat: 52.5376,
    lon: 13.5049,
    address: { road: "Landsberger Allee", houseNumber: "364", city: "Berlin", postcode: "12681" },
  },
  mall: {
    name: "Gesundbrunnen-Center",
    lat: 52.5486,
    lon: 13.3884,
    address: { road: "Badstraße", houseNumber: "4", city: "Berlin", postcode: "13357" },
  },
  kaufland: {
    name: "Kaufland Storkower Straße",
    lat: 52.5262,
    lon: 13.4583,
    // The supermarket's 22 kW posts, billed through a roaming card.
    fence: charger(0.49, 0, 120),
    address: { road: "Storkower Straße", houseNumber: "139", city: "Berlin", postcode: "10407" },
  },
  airport: {
    name: "BER Terminal 1",
    lat: 52.3646,
    lon: 13.5087,
    address: {
      road: "Melli-Beese-Ring",
      houseNumber: "1",
      city: "Schönefeld",
      postcode: "12529",
      state: "Brandenburg",
    },
  },
  tierpark: {
    name: "Tierpark Berlin",
    lat: 52.4993,
    lon: 13.5317,
    address: { road: "Am Tierpark", houseNumber: "125", city: "Berlin", postcode: "10319" },
  },
  lakeside: {
    name: "Strandbad Wannsee",
    lat: 52.4325,
    lon: 13.1745,
    address: { road: "Wannseebadweg", houseNumber: "25", city: "Berlin", postcode: "14129" },
  },
  muggelsee: {
    name: "Strandbad Müggelsee",
    lat: 52.4412,
    lon: 13.6476,
    address: { road: "Fürstenwalder Damm", houseNumber: "838", city: "Berlin", postcode: "12589" },
  },
  supercharger: {
    name: "Supercharger Tempelhof",
    lat: 52.4771,
    lon: 13.4394,
    fence: { radius: 200, billing: "per_kwh", rate: 0.55, sessionFeeCents: 99 },
    address: { road: "Tempelhofer Damm", houseNumber: "227", city: "Berlin", postcode: "12099" },
  },

  // ── Brandenburg and the neighbouring cities ─────────────────────────────
  potsdam: {
    name: "Park Sanssouci",
    lat: 52.4005,
    lon: 13.0381,
    address: { road: "Maulbeerallee", city: "Potsdam", postcode: "14469", state: "Brandenburg" },
  },
  liepnitzsee: {
    name: "Liepnitzsee",
    lat: 52.7381,
    lon: 13.5042,
    address: { road: "Am Liepnitzsee", city: "Wandlitz", postcode: "16348", state: "Brandenburg" },
  },
  spreewald: {
    name: "Spreewaldhafen Lübbenau",
    lat: 51.8668,
    lon: 13.9701,
    address: { road: "Dammstraße", city: "Lübbenau", postcode: "03222", state: "Brandenburg" },
  },
  saarow: {
    name: "Bad Saarow Seepromenade",
    lat: 52.2871,
    lon: 14.0644,
    address: { road: "Seestraße", city: "Bad Saarow", postcode: "15526", state: "Brandenburg" },
  },
  brandenburg: {
    name: "Brandenburg an der Havel",
    lat: 52.4118,
    lon: 12.5571,
    address: {
      road: "Neustädtischer Markt",
      city: "Brandenburg an der Havel",
      postcode: "14776",
      state: "Brandenburg",
    },
  },
  chorin: {
    name: "Kloster Chorin",
    lat: 52.8897,
    lon: 13.8739,
    address: { road: "Amt Chorin", houseNumber: "11a", city: "Chorin", postcode: "16230", state: "Brandenburg" },
  },
  leipzig: {
    name: "Supercharger Leipzig Nord",
    lat: 51.3397,
    lon: 12.3731,
    fence: charger(0.61, 0, 250),
    address: { road: "Maximilianallee", houseNumber: "4", city: "Leipzig", postcode: "04129", state: "Sachsen" },
  },
  neuruppin: {
    name: "Supercharger Neuruppin",
    lat: 52.9236,
    lon: 12.8034,
    fence: charger(0.52),
    address: { road: "An der B167", houseNumber: "2", city: "Neuruppin", postcode: "16816", state: "Brandenburg" },
  },
  rostock: {
    name: "Strandhotel Warnemünde",
    lat: 54.1766,
    lon: 12.0806,
    fence: { radius: 180, billing: "per_kwh", rate: 0.49, sessionFeeCents: 200 },
    address: {
      road: "Seestraße",
      houseNumber: "12",
      city: "Rostock",
      postcode: "18119",
      state: "Mecklenburg-Vorpommern",
    },
  },

  // ── Superchargers on the motorways out of Berlin ────────────────────────
  dresdenSc: {
    name: "Supercharger Dresden",
    lat: 51.1003,
    lon: 13.6863,
    fence: charger(0.58),
    address: { road: "Washingtonstraße", city: "Dresden", postcode: "01139", state: "Sachsen" },
  },
  helmstedtSc: {
    name: "Supercharger Helmstedt",
    lat: 52.2408,
    lon: 11.0204,
    fence: charger(0.57),
    address: { road: "Magdeburger Tor", city: "Helmstedt", postcode: "38350", state: "Niedersachsen" },
  },
  oeynhausenSc: {
    name: "Supercharger Bad Oeynhausen",
    lat: 52.2052,
    lon: 8.7744,
    fence: charger(0.59),
    address: { road: "Werster Straße", city: "Bad Oeynhausen", postcode: "32549", state: "Nordrhein-Westfalen" },
  },
  cottbusSc: {
    name: "Supercharger Cottbus",
    lat: 51.7854,
    lon: 14.2895,
    fence: charger(0.56),
    address: { road: "Am Seegraben", city: "Cottbus", postcode: "03051", state: "Brandenburg" },
  },
  szczecinSc: {
    name: "Supercharger Szczecin",
    lat: 53.3973,
    lon: 14.6553,
    fence: charger(0.47),
    address: { road: "Struga", city: "Szczecin", postcode: "70-777", state: "Zachodniopomorskie", country: "Poland" },
  },

  // ── Further afield ──────────────────────────────────────────────────────
  pragueSc: {
    name: "Supercharger Praha Chodov",
    lat: 50.0317,
    lon: 14.4914,
    fence: charger(0.5),
    address: { road: "Roztylská", city: "Praha", postcode: "148 00", state: "Hlavní město Praha", country: "Czechia" },
  },
  prague: {
    name: "Hotel garage, Praha 1",
    lat: 50.0884,
    lon: 14.4277,
    fence: { radius: 150, billing: "per_kwh", rate: 0.42, sessionFeeCents: 0 },
    address: {
      road: "Rybná",
      houseNumber: "20",
      city: "Praha",
      postcode: "110 00",
      state: "Hlavní město Praha",
      country: "Czechia",
    },
  },
  brnoSc: {
    name: "Supercharger Brno",
    lat: 49.1514,
    lon: 16.6853,
    fence: charger(0.5),
    address: { road: "Vídeňská", city: "Brno", postcode: "619 00", state: "Jihomoravský kraj", country: "Czechia" },
  },
  vienna: {
    name: "Hotel garage, Wien Mariahilf",
    lat: 48.1965,
    lon: 16.3517,
    fence: { radius: 150, billing: "per_kwh", rate: 0.45, sessionFeeCents: 300 },
    address: {
      road: "Mariahilfer Straße",
      houseNumber: "57",
      city: "Wien",
      postcode: "1060",
      state: "Wien",
      country: "Austria",
    },
  },
  hengeloSc: {
    name: "Supercharger Hengelo",
    lat: 52.2715,
    lon: 6.7726,
    fence: charger(0.55),
    address: { road: "Westermaatweg", city: "Hengelo", postcode: "7556", state: "Overijssel", country: "Netherlands" },
  },
  amsterdam: {
    name: "Parkhaus Europaplein, Amsterdam",
    lat: 52.3412,
    lon: 4.8888,
    fence: { radius: 150, billing: "per_kwh", rate: 0.59, sessionFeeCents: 0 },
    address: {
      road: "Europaplein",
      houseNumber: "24",
      city: "Amsterdam",
      postcode: "1078 GZ",
      state: "Noord-Holland",
      country: "Netherlands",
    },
  },
  wroclawSc: {
    name: "Supercharger Wrocław Bielany",
    lat: 51.0405,
    lon: 16.9617,
    fence: charger(0.46),
    address: {
      road: "Czekoladowa",
      city: "Bielany Wrocławskie",
      postcode: "55-040",
      state: "Dolnośląskie",
      country: "Poland",
    },
  },
  wroclaw: {
    name: "Hotel garage, Wrocław Rynek",
    lat: 51.1093,
    lon: 17.0262,
    fence: { radius: 150, billing: "per_kwh", rate: 0.38, sessionFeeCents: 0 },
    address: {
      road: "Kiełbaśnicza",
      houseNumber: "24",
      city: "Wrocław",
      postcode: "50-108",
      state: "Dolnośląskie",
      country: "Poland",
    },
  },
  gliwiceSc: {
    name: "Supercharger Gliwice",
    lat: 50.2946,
    lon: 18.6187,
    fence: charger(0.46),
    address: { road: "Pszczyńska", city: "Gliwice", postcode: "44-100", state: "Śląskie", country: "Poland" },
  },
  krakow: {
    name: "Hotel garage, Kraków Kazimierz",
    lat: 50.0513,
    lon: 19.9445,
    fence: { radius: 150, billing: "per_kwh", rate: 0.38, sessionFeeCents: 0 },
    address: {
      road: "Józefa",
      houseNumber: "11",
      city: "Kraków",
      postcode: "31-056",
      state: "Małopolskie",
      country: "Poland",
    },
  },
  koszalinSc: {
    name: "Supercharger Koszalin",
    lat: 54.1667,
    lon: 16.1408,
    fence: charger(0.46),
    address: {
      road: "Gnieźnieńska",
      city: "Koszalin",
      postcode: "75-736",
      state: "Zachodniopomorskie",
      country: "Poland",
    },
  },
  gdansk: {
    name: "Hotel garage, Gdańsk Główne Miasto",
    lat: 54.3489,
    lon: 18.6571,
    fence: { radius: 150, billing: "per_kwh", rate: 0.4, sessionFeeCents: 0 },
    address: {
      road: "Chmielna",
      houseNumber: "10",
      city: "Gdańsk",
      postcode: "80-748",
      state: "Pomorskie",
      country: "Poland",
    },
  },
  kolobrzeg: {
    name: "Ferienwohnung Kołobrzeg",
    lat: 54.1822,
    lon: 15.5687,
    fence: { radius: 150, billing: "per_kwh", rate: 0.35, sessionFeeCents: 0 },
    address: {
      road: "Sułkowskiego",
      houseNumber: "7",
      city: "Kołobrzeg",
      postcode: "78-100",
      state: "Zachodniopomorskie",
      country: "Poland",
    },
  },
};

/**
 * Routes between places. `via` pins the road a route takes where OSRM's
 * fastest would not be the one this household drives (or, for the second
 * commute, simply a different one). A route is driven either way; reversed,
 * it is the same road with the clock run backwards.
 */
export const ROUTE_SPECS = {
  // The two ways to the office: down Prenzlauer Allee past Alexanderplatz, or
  // across on Torstraße and down Friedrichstraße.
  commute: { from: "home", to: "office", via: [[52.5219, 13.4132]] },
  commuteAlt: {
    from: "home",
    to: "office",
    via: [
      [52.5291, 13.3989],
      [52.5155, 13.3891],
    ],
  },
  schoolRun: { from: "home", to: "school" },
  gym: { from: "home", to: "gym" },
  groceries: { from: "home", to: "market" },
  musicSchool: { from: "home", to: "musicSchool" },
  grandparents: { from: "home", to: "grandparents" },
  friends: { from: "home", to: "friends" },
  ikea: { from: "home", to: "ikea" },
  mall: { from: "home", to: "mall" },
  kaufland: { from: "home", to: "kaufland" },
  airport: { from: "home", to: "airport" },
  tierpark: { from: "home", to: "tierpark" },
  supercharger: { from: "home", to: "supercharger" },
  lake: { from: "home", to: "lakeside" },
  // Back from the lake by way of the office's cheap charger.
  lakeOffice: { from: "lakeside", to: "office" },
  muggelsee: { from: "home", to: "muggelsee" },
  potsdam: { from: "home", to: "potsdam" },
  liepnitzsee: { from: "home", to: "liepnitzsee" },
  spreewald: { from: "home", to: "spreewald" },
  saarow: { from: "home", to: "saarow" },
  brandenburg: { from: "home", to: "brandenburg" },
  chorin: { from: "home", to: "chorin" },

  // Down the A9 to Leipzig.
  leipzigTrip: { from: "home", to: "leipzig" },
  // North to the Baltic on the A19, and back broken at Neuruppin.
  balticTrip: { from: "home", to: "rostock" },
  rostockNeuruppin: { from: "rostock", to: "neuruppin" },
  neuruppinHome: { from: "neuruppin", to: "home" },

  // South: the A13 to Dresden, then the D8 to Prague and the D1 to Brno and Vienna.
  homeDresden: { from: "home", to: "dresdenSc" },
  dresdenPrague: { from: "dresdenSc", to: "prague" },
  dresdenPragueSc: { from: "dresdenSc", to: "pragueSc" },
  pragueBrno: { from: "pragueSc", to: "brnoSc" },
  brnoVienna: { from: "brnoSc", to: "vienna" },

  // West: the A2 to Hanover and on, the A1 and A30 to the Dutch border.
  homeHelmstedt: { from: "home", to: "helmstedtSc" },
  helmstedtOeynhausen: { from: "helmstedtSc", to: "oeynhausenSc" },
  oeynhausenHengelo: { from: "oeynhausenSc", to: "hengeloSc" },
  hengeloAmsterdam: { from: "hengeloSc", to: "amsterdam" },

  // East: the A15 to the border at Forst, then the A4 across Silesia.
  homeCottbus: { from: "home", to: "cottbusSc" },
  cottbusWroclaw: { from: "cottbusSc", to: "wroclaw" },
  cottbusWroclawSc: { from: "cottbusSc", to: "wroclawSc" },
  wroclawGliwice: { from: "wroclawSc", to: "gliwiceSc" },
  gliwiceKrakow: { from: "gliwiceSc", to: "krakow" },

  // North-east: the A11 to Szczecin and along the Polish coast.
  homeSzczecin: { from: "home", to: "szczecinSc" },
  szczecinKoszalin: { from: "szczecinSc", to: "koszalinSc" },
  koszalinGdansk: { from: "koszalinSc", to: "gdansk" },
  szczecinKolobrzeg: { from: "szczecinSc", to: "kolobrzeg" },
};
