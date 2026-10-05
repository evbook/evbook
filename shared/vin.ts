/**
 * Tesla VIN decoder.
 *
 * A Tesla VIN is 17 characters and every position carries meaning, so a car's
 * model, model year, factory, body, drive unit and — the reason this exists —
 * its battery chemistry can be read without asking the owner or the API.
 *
 * The mappings follow the two public decoders this was written against:
 * teslatap.com's decoder (`/js/teslatap_vin43.js`) and findmyelectric.com's
 * table. Both are community reverse-engineering, not a Tesla document, so a
 * code Tesla has not used publicly reads as `null` rather than a guess.
 *
 * Beyond the positions themselves, the era tables at the bottom infer what a
 * given model and year shipped with — cell type and supplier, infotainment
 * computer, Autopilot computer, and which refresh (Raven, Palladium, Highland,
 * Juniper) the car belongs to. Those follow ev-inventory.com's buyers' guides
 * and model history, community documentation again.
 *
 *   position  1-3  world manufacturer identifier
 *   position  4    model
 *   position  5    body type and drive side
 *   position  6    restraint system (GVWR class on trucks, region on Roadsters)
 *   position  7    battery type — `F` is the LFP marker
 *   position  8    drive unit
 *   position  9    check digit
 *   position 10    model year
 *   position 11    plant of manufacture
 *   position 12    build phase, or the leading serial digit
 *   position 12-17 serial number
 *
 * Nothing here is authoritative: a real Tesla account overwrites `cars.model`
 * and friends on the next `update_car`, and the battery chemistry is a starting
 * value the owner can override. Position 7 in particular is known to be
 * reliable on China-built cars and occasionally wrong elsewhere.
 */

/** Fourth character — the same letter `cars.model` stores. */
type TeslaModelCode = "S" | "3" | "X" | "Y" | "R" | "C" | "T";

type DriveSide = "LHD" | "RHD";

/** `lfp` = lithium iron phosphate; `nickel` = the NCA/NMC lithium-ion packs. */
type BatteryChemistry = "lfp" | "nickel";

export interface VinDetails {
  /** Trimmed and upper-cased. */
  vin: string;
  /** False when the string is not a plausible 17-character Tesla VIN. */
  valid: boolean;

  /** Positions 1-3, e.g. `LRW`. */
  wmi: string | null;
  /** What the WMI stands for, e.g. `Tesla — China`. */
  manufacturer: string | null;

  model: TeslaModelCode | null;
  /** `Model 3`, `Cybertruck`, … */
  modelName: string | null;
  modelYear: number | null;

  bodyType: string | null;
  driveSide: DriveSide | null;
  /** Position 6 on a car. Null on Cybertruck, Semi and Roadster. */
  restraintSystem: string | null;
  /** Position 6 on a Cybertruck or Semi. */
  gvwrClass: string | null;
  /** Position 6 on a Roadster — the market it was built for. */
  roadsterRegion: string | null;

  /** Position 7 spelled out, e.g. `Lithium iron phosphate battery`. */
  batteryType: string | null;
  batteryChemistry: BatteryChemistry | null;

  /** Position 8 spelled out, e.g. `Dual motor — Performance`. */
  driveUnit: string | null;
  motorCount: number | null;
  /** True for the performance drive units, false for the standard ones. */
  performance: boolean | null;

  /**
   * The refresh generation the model year falls in, e.g. `Raven` or `Highland`.
   * Inferred from model and year, not read off a position — as is everything
   * down to `zeroTo100Kmh`. A year Tesla changed over mid-production names both
   * sides.
   */
  generation: string | null;
  /** Cell format and supplier, e.g. `2170 cylindrical — Panasonic NCA`. */
  cells: string | null;
  /** Pack designation, size and cell code, e.g. `BT43 — 79 kWh (5L)`. */
  pack: string | null;
  /**
   * Roughly what a charging-session estimate would have read when the pack was
   * new — the usable figure, not the nameplate one, so it is comparable to a
   * measured capacity and can anchor a degradation-since-new number. Null when
   * the VIN cannot pin the pack down.
   */
  usableWhenNewKwh: number | null;
  /**
   * The packs the VIN cannot decide between, where each side's figure is
   * known — the owner can, so these feed a picker whose choice overrides
   * `usableWhenNewKwh`. Null when the VIN resolves to one pack (or none).
   */
  packCandidates: { pack: string; usableWhenNewKwh: number }[] | null;
  /** Motor layout and rough output, e.g. `Front induction ≈150 kW + …`. */
  motors: string | null;
  /** The trim's EPA rating when new, miles. */
  epaRangeMi: number | null;
  /** The trim's WLTP rating when new, kilometres. */
  wltpRangeKm: number | null;
  /** Brochure sprint times when new, seconds. */
  zeroTo60Mph: number | null;
  zeroTo100Kmh: number | null;
  /** Infotainment computer, e.g. `MCU2 — Intel Atom`. */
  mcu: string | null;
  /** Autopilot computer, e.g. `HW3`. */
  autopilotHardware: string | null;

  /** Position 11, e.g. `Fremont, California, USA`. */
  plant: string | null;
  /** Position 12 when it is a letter, e.g. `Production vehicle`. */
  buildPhase: string | null;
  /** Positions 12-17, digits only. */
  serial: string | null;

  /** Position 9 as written. */
  checkDigit: string | null;
  /** Whether position 9 matches the digit computed from the other sixteen. */
  checkDigitValid: boolean | null;
}

const EMPTY: Omit<VinDetails, "vin"> = {
  valid: false,
  wmi: null,
  manufacturer: null,
  model: null,
  modelName: null,
  modelYear: null,
  bodyType: null,
  driveSide: null,
  restraintSystem: null,
  gvwrClass: null,
  roadsterRegion: null,
  batteryType: null,
  batteryChemistry: null,
  driveUnit: null,
  motorCount: null,
  performance: null,
  generation: null,
  cells: null,
  pack: null,
  usableWhenNewKwh: null,
  packCandidates: null,
  motors: null,
  epaRangeMi: null,
  wltpRangeKm: null,
  zeroTo60Mph: null,
  zeroTo100Kmh: null,
  mcu: null,
  autopilotHardware: null,
  plant: null,
  buildPhase: null,
  serial: null,
  checkDigit: null,
  checkDigitValid: null,
};

/** Tesla's world manufacturer identifiers. The factory itself is position 11. */
const MANUFACTURERS: Record<string, string> = {
  "5YJ": "Tesla, Inc. — USA",
  "7SA": "Tesla, Inc. — USA (MPV: Model X/Y)",
  "7G2": "Tesla, Inc. — USA (truck: Cybertruck/Semi)",
  LRW: "Tesla — China",
  XP7: "Tesla — Germany",
  SFZ: "Tesla Motors — UK (Roadster)",
};

const MODEL_NAMES: Record<TeslaModelCode, string> = {
  S: "Model S",
  "3": "Model 3",
  X: "Model X",
  Y: "Model Y",
  R: "Roadster",
  C: "Cybertruck",
  T: "Semi",
};

/** Position 10. Letters run 2010-2030; the digits are the Roadster years. */
const YEAR_LETTERS = "ABCDEFGHJKLMNPRSTVWXY";
const YEAR_LETTER_BASE = 2010;
const YEAR_DIGITS = "6789";
const YEAR_DIGIT_BASE = 2006;

/** Position 11. */
const PLANTS: Record<string, string> = {
  "1": "Menlo Park, California, USA",
  "3": "Hethel, UK",
  A: "Austin, Texas, USA",
  B: "Berlin-Brandenburg, Germany",
  C: "Shanghai, China",
  F: "Fremont, California, USA",
  G: "Berlin-Brandenburg, Germany",
  N: "Reno, Nevada, USA",
  P: "Palo Alto, California, USA",
  R: "Research",
};

/** Position 12 when it is a letter. Digits are part of the serial instead. */
const BUILD_PHASES: Record<string, string> = {
  A: "Alpha prototype",
  B: "Beta prototype",
  E: "Evaluation prototype (Roadster)",
  F: "Founder series",
  M: "Mule (early Roadster prototype)",
  P: "Production vehicle",
  R: "Release candidate",
  S: "Signature series",
  V: "Validation prototype (Roadster)",
};

/** I, O and Q are never VIN characters — they read as 1 and 0. */
const VIN_PATTERN = /^[A-HJ-NPR-Z0-9]{17}$/;

const isTruck = (model: TeslaModelCode | null) => model === "C" || model === "T";

/** Position 5 — body style, and which side the wheel is on. */
function decodeBody(model: TeslaModelCode | null, code: string): { label: string; side: DriveSide | null } | null {
  switch (code) {
    case "1":
      // Seen on a Model S 100D; Tesla never documented what it stands for.
      return { label: "Unknown body type", side: null };
    case "A":
      if (model === "R" || model === "X") return null;
      return { label: "5-door hatchback", side: "LHD" };
    case "B":
      if (isTruck(model)) return { label: "Day cab", side: null };
      if (model === "R" || model === "X") return null;
      return { label: "5-door hatchback", side: "RHD" };
    case "C":
      return model === "X" ? { label: "Class E MPV, 5-door (6001-7000 lbs GVWR)", side: "LHD" } : null;
    case "D":
      return model === "X" ? { label: "Class E MPV, 5-door (6001-7000 lbs GVWR)", side: "RHD" } : null;
    case "E":
      if (isTruck(model)) return { label: "Truck", side: "LHD" };
      if (model === "R") return { label: "Convertible", side: null };
      return { label: "4-door sedan", side: "LHD" };
    case "F":
      return model === "3" ? { label: "4-door sedan", side: "RHD" } : null;
    case "G":
      return model === "Y" ? { label: "Class D MPV, 5-door", side: "LHD" } : null;
    case "H":
      return { label: "Class D MPV, 5-door", side: "RHD" };
    default:
      return null;
  }
}

/** Position 6 on a Cybertruck or Semi. */
function decodeGvwr(code: string): string | null {
  switch (code) {
    case "E":
      return "Class 8 — over 33,001 lbs";
    case "G":
      return "Class G — 8,001-9,000 lbs";
    case "H":
      return "Class H — 9,001-10,000 lbs";
    default:
      return null;
  }
}

/** Position 7 on a Roadster, where the battery position holds the restraints. */
function decodeRoadsterRestraint(code: string): string | null {
  switch (code) {
    case "1":
    case "A":
      return "Type 2 USA seat belts, dual airbags";
    case "B":
      return "Non-USA";
    default:
      return null;
  }
}

/** Position 6 on a Roadster. */
function decodeRoadsterRegion(code: string): string | null {
  switch (code) {
    case "1":
      return "USA (LHD)";
    case "2":
      return "Europe (LHD)";
    case "3":
      return "Europe (RHD)";
    case "6":
      return "Canada (LHD)";
    case "8":
      return "Hong Kong (RHD)";
    default:
      return null;
  }
}

/**
 * Position 6 on a car. The full restraint strings differ by model year in ways
 * that do not matter for display, so each code is summarised once.
 */
function decodeRestraint(code: string): string | null {
  switch (code) {
    case "1":
      return "Type 2 manual belts (front, rear x3), front airbags, side inflatable restraints, knee airbags";
    case "2":
      return "Type 2 manual belts (front, rear x3), front airbags, side inflatable restraints, knee airbags (EU)";
    case "3":
      return "Type 2 manual belts (front, rear x2), front airbags, side inflatable restraints, knee airbags";
    case "4":
      return "Type 2 manual belts (front, rear x2), front airbags, side inflatable restraints, knee airbags (front)";
    case "5":
      return "Type 2 manual belts (front, rear x2), front airbags, side inflatable restraints";
    case "6":
      return "Type 2 manual belts (front, rear x3), front airbags, side inflatable restraints";
    case "7":
      return "Type 2 manual belts (front, rear x3), front airbags, side inflatable restraints, active hood";
    case "8":
      return "Type 2 manual belts (front, rear x2), front airbags, side inflatable restraints, active hood";
    case "A":
      return "Type 2 manual belts (front, centre x3, third row x2), front airbags, PODS, side inflatable restraints, knee airbags";
    case "B":
    case "C":
      return "Type 2 manual belts (front, centre x2, third row x2), front airbags, PODS, side inflatable restraints";
    case "D":
      return "Type 2 manual belts (front, centre x3), front airbags, PODS, side inflatable restraints (5 seats)";
    default:
      return null;
  }
}

/**
 * Position 7 — the charger on the earliest cars, the battery from 2014 on.
 *
 * `F` is the whole point of this module: it is Tesla's marker for a lithium
 * iron phosphate pack. The pre-2015 charger codes predate LFP entirely, so
 * their chemistry is known even though the character does not encode it.
 */
function decodeBattery(code: string, year: number | null): { label: string; chemistry: BatteryChemistry | null } | null {
  const before = (limit: number) => year === null || year <= limit;
  const from = (limit: number) => year === null || year >= limit;

  switch (code) {
    case "A":
      return before(2014) ? { label: "10 kW charger", chemistry: "nickel" } : null;
    case "B":
      return before(2014) ? { label: "20 kW charger", chemistry: "nickel" } : null;
    case "C":
      return before(2014) ? { label: "10 kW charger, with DC fast charge", chemistry: "nickel" } : null;
    case "D":
      return before(2014) ? { label: "20 kW charger, with DC fast charge", chemistry: "nickel" } : null;
    case "E":
      return from(2015) ? { label: "Lithium-ion battery", chemistry: "nickel" } : null;
    case "F":
      return from(2019) ? { label: "Lithium iron phosphate (LFP) battery", chemistry: "lfp" } : null;
    case "H":
      return from(2014) ? { label: "Lithium-ion battery — high capacity", chemistry: "nickel" } : null;
    case "S":
      return from(2014) ? { label: "Lithium-ion battery — standard capacity", chemistry: "nickel" } : null;
    case "V":
      return from(2015) ? { label: "Lithium-ion battery — ultra high capacity", chemistry: "nickel" } : null;
    default:
      return null;
  }
}

interface DriveUnit {
  label: string;
  motors: number | null;
  performance: boolean | null;
}

/** Position 8 on a Roadster. */
function decodeRoadsterDriveUnit(code: string): DriveUnit | null {
  switch (code) {
    case "1":
      return { label: "Tesla M6B motor", motors: 1, performance: false };
    case "3":
      return { label: "Tesla M6S motor", motors: 1, performance: true };
    case "B":
      return { label: "Tesla 56C motor", motors: 1, performance: null };
    default:
      return null;
  }
}

/** Position 8 on a Cybertruck or Semi. */
function decodeTruckDriveUnit(code: string): DriveUnit | null {
  switch (code) {
    case "B":
      return { label: "Dual drive rear axle, air brakes (Semi)", motors: 2, performance: null };
    case "D":
      return { label: "Dual motor — standard (Cybertruck)", motors: 2, performance: false };
    case "E":
      return { label: "Triple motor — performance (Cybertruck)", motors: 3, performance: true };
    default:
      return null;
  }
}

/**
 * Position 8 on a car. Tesla reused characters as the line-up changed, so the
 * model year decides between readings — an unknown year takes the newest one,
 * which is what an undated VIN most likely is.
 *
 * The Model 3 and Y labels use the trims Tesla actually sold: a dual motor is a
 * Long Range or a Performance, never a "standard", and a single motor is a
 * Standard Range or a Long Range, never a Performance. Position 8 says how many
 * motors and whether it is the performance unit, so where the two remaining
 * trims share a character the label names both rather than picking one. The
 * labels do not repeat which car the character belongs to — the display always
 * has the model on the line above.
 */
function decodeDriveUnit(model: TeslaModelCode | null, code: string, year: number | null): DriveUnit | null {
  const from = (limit: number) => year === null || year >= limit;

  switch (code) {
    case "A":
      return from(2017) ? { label: "Single motor — Standard or Long Range", motors: 1, performance: false } : null;
    case "B":
      if (from(2020)) return { label: "Dual motor — Long Range", motors: 2, performance: false };
      if (year !== null && year >= 2018)
        return { label: "Dual motor — Long Range or Performance", motors: 2, performance: null };
      return null;
    case "C":
      if (from(2020)) return { label: "Dual motor — Performance", motors: 2, performance: true };
      return model === "S" ? { label: "Base A/C motor, tier 2 battery (31-40 kWh)", motors: 1, performance: false } : null;
    case "D":
      return from(2020) ? { label: "Single motor — Standard or Long Range", motors: 1, performance: false } : null;
    case "E":
      return from(2020) ? { label: "Dual motor — Long Range", motors: 2, performance: false } : null;
    case "F":
      return from(2020) ? { label: "Dual motor — Performance", motors: 2, performance: true } : null;
    case "G":
      return { label: "Base A/C motor, tier 4 battery (51-60 kWh)", motors: 1, performance: false };
    case "J":
      return from(2020) ? { label: "Single motor", motors: 1, performance: false } : null;
    case "K":
      return from(2021) ? { label: "Dual motor", motors: 2, performance: false } : null;
    case "L":
      return from(2020) ? { label: "Dual motor — Performance", motors: 2, performance: true } : null;
    case "N":
      return { label: "Base A/C motor, tier 7 battery (81-90 kWh)", motors: 1, performance: false };
    case "P":
      return { label: "Performance A/C motor, tier 7 battery (81-90 kWh)", motors: 1, performance: true };
    case "R":
      return from(2021) ? { label: "Single motor", motors: 1, performance: false } : null;
    case "S":
      return from(2021) ? { label: "Motor", motors: null, performance: null } : null;
    case "T":
      return from(2024) ? { label: "Dual motor — Performance", motors: 2, performance: true } : null;
    case "1":
      return from(2014) ? { label: "Single motor — three-phase A/C induction", motors: 1, performance: false } : null;
    case "2":
      return from(2014) ? { label: "Dual motor — three-phase A/C induction", motors: 2, performance: false } : null;
    case "3":
      return from(2015)
        ? { label: "Performance single motor — three-phase A/C induction", motors: 1, performance: true }
        : null;
    case "4":
      return from(2015) ? { label: "Performance dual motor", motors: 2, performance: true } : null;
    case "5":
      return from(2021) ? { label: "P2 dual motor", motors: 2, performance: true } : null;
    case "6":
      return from(2021) ? { label: "P2 tri motor", motors: 3, performance: true } : null;
    default:
      return null;
  }
}

/**
 * What a model shipped with in a given year. These are inferred from the model
 * year rather than read off a dedicated position: Tesla swaps the infotainment
 * computer, the Autopilot computer and the platform itself mid-production, and
 * the year is the closest the VIN gets to a build date. Each entry starts an
 * era; the newest entry at or before the year wins. A year the changeover fell
 * inside names both sides rather than picking one.
 *
 * Sourced from ev-inventory.com's buyers' guides and model history.
 */
type EraTable = [firstYear: number, label: string][];

function pickEra(year: number | null, eras: EraTable | undefined): string | null {
  if (year === null || eras === undefined) return null;
  let label: string | null = null;
  for (const [from, name] of eras) if (year >= from) label = name;
  return label;
}

const GENERATIONS: Partial<Record<TeslaModelCode, EraTable>> = {
  S: [
    [2012, "Original"],
    [2016, "Original or facelift (changed April 2016)"],
    [2017, "Facelift"],
    [2019, "Facelift or Raven (changed April 2019)"],
    [2020, "Raven"],
    [2021, "Raven or Palladium (changed mid-2021)"],
    [2022, "Palladium (2021 redesign)"],
  ],
  X: [
    [2015, "Original"],
    [2019, "Original or Raven (changed April 2019)"],
    [2020, "Raven"],
    [2021, "Raven or Palladium (production paused for the changeover)"],
    [2022, "Palladium (2021 redesign)"],
  ],
  "3": [
    [2017, "Original"],
    [2021, "2021 refresh"],
    [2024, "Highland"],
  ],
  Y: [
    [2020, "Original"],
    [2025, "Original or Juniper (changed early 2025)"],
    [2026, "Juniper"],
  ],
};

/**
 * The S and X carry the numbered MCU generations; the 3 and Y launched on the
 * Intel unit the S got as MCU2, so their eras go by processor instead.
 */
const MCU_SX: EraTable = [
  [2012, "MCU1 — Nvidia Tegra"],
  [2018, "MCU1 or MCU2 (changed March 2018)"],
  [2019, "MCU2 — Intel Atom"],
  [2021, "MCU2 or MCU3 (with the Palladium redesign)"],
  [2022, "MCU3 — AMD Ryzen"],
];

const MCU_3Y: EraTable = [
  [2017, "Intel Atom"],
  [2022, "Intel Atom or AMD Ryzen (changed early 2022)"],
  [2023, "AMD Ryzen"],
];

const MCUS: Partial<Record<TeslaModelCode, EraTable>> = {
  S: MCU_SX,
  X: MCU_SX,
  "3": MCU_3Y,
  Y: MCU_3Y,
  C: [[2023, "AMD Ryzen"]],
};

/** HW2.5 through HW4 are shared across the line-up once a model reaches them. */
const AUTOPILOT_SX_TAIL: EraTable = [
  [2017, "HW2 or HW2.5 (changed August 2017)"],
  [2018, "HW2.5"],
  [2019, "HW2.5 or HW3 (changed mid-2019)"],
  [2020, "HW3"],
  [2023, "HW3 or HW4 (changed early 2023)"],
  [2024, "HW4"],
];

const AUTOPILOT: Partial<Record<TeslaModelCode, EraTable>> = {
  S: [
    [2012, "None — built before Autopilot"],
    [2014, "None or AP1 (fitted from October 2014)"],
    [2015, "AP1 — Mobileye"],
    [2016, "AP1 or HW2 (changed October 2016)"],
    ...AUTOPILOT_SX_TAIL,
  ],
  X: [
    [2015, "AP1 — Mobileye"],
    [2016, "AP1 or HW2 (changed October 2016)"],
    ...AUTOPILOT_SX_TAIL,
  ],
  "3": [
    [2017, "HW2.5"],
    [2019, "HW2.5 or HW3 (changed April 2019)"],
    [2020, "HW3"],
    [2024, "HW4"],
  ],
  Y: [
    [2020, "HW3"],
    [2023, "HW3 or HW4 (changed mid-2023)"],
    [2024, "HW4"],
  ],
  C: [[2023, "HW4"]],
};

/**
 * Cell format and supplier. The S and X have used Panasonic 18650s from the
 * start; the 3 and Y run 2170s whose supplier follows the factory, except the
 * LFP packs, which are CATL prismatics wherever they are fitted. An unknown
 * chemistry on a 3 or Y stays null — it could be either format.
 */
function decodeCells(
  model: TeslaModelCode | null,
  plantCode: string,
  chemistry: BatteryChemistry | null,
): string | null {
  if (chemistry === "lfp") return "Prismatic LFP — CATL";
  switch (model) {
    case "S":
    case "X":
      return "18650 cylindrical — Panasonic NCA";
    case "C":
      return "4680 cylindrical — structural pack";
    case "3":
      if (chemistry === null) return null;
      return plantCode === "C" ? "2170 cylindrical — LG NMC" : "2170 cylindrical — Panasonic NCA";
    case "Y":
      if (chemistry === null) return null;
      // Austin has built both packs side by side: 4680 structural on the entry
      // AWD, 2170 on the rest. The VIN does not say which.
      if (plantCode === "A") return "2170 cylindrical, or 4680 structural pack — varies by trim";
      return plantCode === "C" || plantCode === "B" || plantCode === "G"
        ? "2170 cylindrical — LG NMC"
        : "2170 cylindrical — Panasonic NCA";
    default:
      return null;
  }
}

/**
 * What the trim the VIN pins down shipped as: pack designation and size, motor
 * layout, and the brochure range and sprint figures when the car was new.
 *
 * The model, year, factory, drive-unit character and the LFP flag together
 * often resolve to a single configuration, and for those the guides give the
 * pack code (BT43), its size, the import cell code (5L for the LG cells), the
 * motor split and the ratings. Everything here is approximate community data —
 * a brochure figure, never a measurement of this car — hence the `≈` on every
 * number. Configurations the VIN cannot separate stay null or name both sides,
 * and the Model S and X packs before Palladium stay null entirely: their size
 * followed the trim badge (60/75/100), which the VIN does not carry.
 *
 * Where a year fitted more than one pack, the figures follow the pack that
 * dominated that year's production rather than an average of the two — an
 * averaged capacity matches no car that was ever built — and `packCandidates`
 * carries the alternatives for the owner to pick from.
 */
interface VariantSpec {
  pack: string | null;
  /** Usable capacity when new — comparable to a charging-session estimate. */
  usableWhenNewKwh: number | null;
  /** Each side of an unresolved pack, when its own usable figure is known. */
  packCandidates: { pack: string; usableWhenNewKwh: number }[] | null;
  motors: string | null;
  epaRangeMi: number | null;
  wltpRangeKm: number | null;
  zeroTo60Mph: number | null;
  zeroTo100Kmh: number | null;
}

const NO_SPEC: VariantSpec = {
  pack: null,
  usableWhenNewKwh: null,
  packCandidates: null,
  motors: null,
  epaRangeMi: null,
  wltpRangeKm: null,
  zeroTo60Mph: null,
  zeroTo100Kmh: null,
};

function spec(
  pack: string | null,
  usableWhenNewKwh: number | null,
  motors: string | null,
  epaRangeMi: number | null,
  wltpRangeKm: number | null,
  zeroTo60Mph: number | null,
  zeroTo100Kmh: number | null,
  packCandidates: { pack: string; usableWhenNewKwh: number }[] | null = null,
): VariantSpec {
  return { pack, usableWhenNewKwh, packCandidates, motors, epaRangeMi, wltpRangeKm, zeroTo60Mph, zeroTo100Kmh };
}

/** The 3 and Y share their motor family; only the rear unit's tune differs. */
const MOTOR_RWD = "Rear permanent-magnet, ≈200 kW";
const MOTOR_LR = "Front induction ≈150 kW + rear permanent-magnet ≈190 kW";
const MOTOR_PERF = "Front induction ≈150 kW + rear permanent-magnet ≈220 kW";

/** Era tables of specs, resolved like the label tables above. */
function pickSpec(year: number | null, eras: [number, VariantSpec][]): VariantSpec | null {
  if (year === null) return null;
  let found: VariantSpec | null = null;
  for (const [from, s] of eras) if (year >= from) found = s;
  return found;
}

const EAST_PLANTS = new Set(["C", "B", "G"]); // Shanghai and Berlin — the LG/CATL packs

function variantSpec(
  model: TeslaModelCode | null,
  rawDriveCode: string,
  year: number | null,
  plantCode: string,
  chemistry: BatteryChemistry | null,
): VariantSpec {
  const east = EAST_PLANTS.has(plantCode);

  // Tesla re-lettered position 8 from mid-2022: J and R took over the single
  // motor, K the dual, L the performance unit. Same configurations, new
  // characters, so they fold onto the letters the tables are written in. T
  // (the 2024+ performance code) stays out: it arrived with Highland and
  // Juniper, whose packs these tables do not know.
  const driveCode =
    rawDriveCode === "J" || rawDriveCode === "R"
      ? model === "Y" ? "D" : "A"
      : rawDriveCode === "K"
        ? model === "Y" ? "E" : "B"
        : rawDriveCode === "L"
          ? model === "Y" ? "F" : rawDriveCode
          : rawDriveCode;

  if (model === "3") {
    if (driveCode === "A") {
      // Single motor — the Standard Range family.
      if (chemistry === "lfp")
        return (
          pickSpec(year, [
            [2020, spec("BTF0 — 55 kWh (6C)", 52, MOTOR_RWD, null, 468, null, 5.6)],
            [2022, spec("BTF1 — 62 kWh (6L)", 60, MOTOR_RWD, 272, 491, 5.8, 6.1)],
          ]) ?? NO_SPEC
        );
      if (chemistry === "nickel")
        return (
          pickSpec(year, [
            [2019, spec("BT35 — 53 kWh (1/1C)", 50, MOTOR_RWD, 240, 409, 5.3, 5.6)],
            [2020, spec("BT35 — 53 kWh (1/1C)", 50, MOTOR_RWD, 250, 409, 5.3, 5.6)],
            [2021, spec("BT41 — 55 kWh (1L)", 53, MOTOR_RWD, 262, 448, 5.3, 5.6)],
          ]) ?? NO_SPEC
        );
      return NO_SPEC;
    }
    if (driveCode === "B") {
      // Dual motor — Long Range; before 2020 the character covered the
      // Performance too, so those years only get the pack.
      //
      // 2021 is the year the pack changed under both factories, so neither side
      // resolves: Shanghai ran the LG BT38 from January and the BT43 from
      // October, and Fremont overlapped three packs (see below). The figures
      // follow the pack that dominated the year and the candidates carry the
      // rest — the BT43 alternative was rated 614 km rather than 580.
      if (east)
        return (
          pickSpec(year, [
            [2021, spec("BT38 (75 kWh, 5/5C) or BT43 (79 kWh, 5L)", 72, MOTOR_LR, null, 580, 4.2, 4.4, [
              { pack: "BT38 — 75 kWh (5/5C)", usableWhenNewKwh: 72 },
              { pack: "BT43 — 79 kWh (5L)", usableWhenNewKwh: 75 },
            ])],
            [2022, spec("BT43 — 79 kWh (5L)", 75, MOTOR_LR, null, 602, 4.2, 4.4)],
          ]) ?? NO_SPEC
        );
      // Fremont's 2021 is the messiest year in the line-up: the BT42 took over
      // in February and accounts for most of it, but the BT37 ran on until
      // November, and the cars Fremont built for Europe from October 2020 to
      // April 2021 carry the LG BT38 the factory otherwise never fitted. The
      // three sit under one drive character, one year and one plant.
      return (
        pickSpec(year, [
          [2018, spec("BT37 — 75 kWh (1/1C)", 74, null, null, null, null, null)],
          [2020, spec("BT37 — 75 kWh (1/1C)", 74, MOTOR_LR, 322, 560, 4.4, 4.6)],
          [
            2021,
            spec(
              "BT42 — 82 kWh (3L), or BT37/BT38 — 75 kWh on cars built before mid-2021",
              78,
              MOTOR_LR,
              353,
              614,
              4.2,
              4.4,
              [
                { pack: "BT42 — 82 kWh (3L)", usableWhenNewKwh: 78 },
                { pack: "BT37 — 75 kWh (1/1C)", usableWhenNewKwh: 74 },
                { pack: "BT38 — 75 kWh (5/5C)", usableWhenNewKwh: 72 },
              ],
            ),
          ],
          [2022, spec("BT42 — 82 kWh (3L)", 78, MOTOR_LR, 353, 614, 4.2, 4.4)],
        ]) ?? NO_SPEC
      );
    }
    if (driveCode === "C") {
      if (east)
        return year !== null && year >= 2021 ? spec("BT43 — 79 kWh (5L)", 75, MOTOR_PERF, null, 567, 3.1, 3.3) : NO_SPEC;
      return (
        pickSpec(year, [
          [2020, spec("BT37 — 75 kWh (1/1C)", 74, MOTOR_PERF, 310, 530, 3.2, 3.4)],
          [2021, spec("BT42 — 82 kWh (3L)", 78, MOTOR_PERF, 315, 547, 3.1, 3.3)],
        ]) ?? NO_SPEC
      );
    }
    return NO_SPEC;
  }

  if (model === "Y") {
    if (driveCode === "D") {
      if (chemistry === "lfp")
        return year !== null && year >= 2021 ? spec("BTF1 — 62 kWh (6L)", 60, MOTOR_RWD, null, 455, 6.6, 6.9) : NO_SPEC;
      if (chemistry === "nickel" && plantCode === "F")
        return year !== null && year >= 2021 ? spec("BT41 — 55 kWh (1L)", 53, MOTOR_RWD, 244, null, 5.3, 5.6) : NO_SPEC;
      return NO_SPEC;
    }
    if (driveCode === "E") {
      if (plantCode === "A")
        // Austin built the 4680 structural pack and the 2170 pack side by side,
        // under the same character — the figures differ too much to average.
        return spec("BT42 — 82 kWh (3L), or BT00 — 67 kWh (4680) — varies by trim", null, `${MOTOR_LR} (FD00 + RD07)`, null, null, null, null, [
          { pack: "BT42 — 82 kWh (3L)", usableWhenNewKwh: 78 },
          { pack: "BT00 — 67 kWh (4680 structural)", usableWhenNewKwh: 64 },
        ]);
      if (east)
        return (
          pickSpec(year, [
            [2021, spec("BT38 — 75 kWh (5/5C)", 72, MOTOR_LR, null, 507, 4.8, 5.0)],
            [2022, spec("BT43 — 79 kWh (5L)", 75, MOTOR_LR, null, 533, 4.8, 5.0)],
          ]) ?? NO_SPEC
        );
      return (
        pickSpec(year, [
          [2020, spec("BT37 — 75 kWh (1/1C)", 74, `${MOTOR_LR} (FD00 + RD01)`, 326, null, 4.8, 5.0)],
          [2021, spec("BT42 — 82 kWh (3L)", 78, `${MOTOR_LR} (FD00 + RD01)`, 330, null, 4.8, 5.0)],
        ]) ?? NO_SPEC
      );
    }
    if (driveCode === "F") {
      if (east)
        return year !== null && year >= 2021 ? spec("BT43 — 79 kWh (5L)", 75, MOTOR_PERF, null, 514, 3.5, 3.7) : NO_SPEC;
      return year !== null && year >= 2021 ? spec("BT42 — 82 kWh (3L)", 78, MOTOR_PERF, 303, null, 3.5, 3.7) : NO_SPEC;
    }
    return NO_SPEC;
  }

  // Palladium S and X encode their two trims as distinct characters, so those
  // two do resolve; everything older hides the pack behind the trim badge.
  if (model === "S") {
    if (driveCode === "5") return spec(null, 95, "Two permanent-magnet motors — ≈500 kW total", 405, 634, 3.1, 3.2);
    if (driveCode === "6") return spec(null, 95, "Three permanent-magnet motors — ≈750 kW total (Plaid)", 396, 600, 2.0, 2.1);
    return NO_SPEC;
  }
  if (model === "X") {
    if (driveCode === "5") return spec(null, 95, "Two permanent-magnet motors — ≈500 kW total", 348, 576, 3.8, 3.9);
    if (driveCode === "6") return spec(null, 95, "Three permanent-magnet motors — ≈750 kW total (Plaid)", 333, 543, 2.5, 2.6);
    return NO_SPEC;
  }

  return NO_SPEC;
}

/**
 * The cells a pack designation pins down, which is more than the factory does.
 *
 * `decodeCells` can only infer format and supplier from the plant, so the
 * Panasonic packs all read as plain 2170s — but the 2021 packs run the taller
 * 2170L cell, and the LG packs differ by module generation (M48 in the BT38,
 * M50 in the BT43). A resolved pack says both, so it wins over the inference.
 */
const PACK_CELLS: Record<string, string> = {
  BT35: "2170 cylindrical — Panasonic NCA",
  BT37: "2170 cylindrical — Panasonic NCA",
  BT38: "2170 cylindrical — LG NMC (M48 modules)",
  BT41: "2170L cylindrical — Panasonic NCA",
  BT42: "2170L cylindrical — Panasonic NCA",
  BT43: "2170 cylindrical — LG NMC (M50 modules)",
};

/**
 * Only an unambiguous pack refines the cells: an either-or label's leading
 * designation is just the first of several, and the packs it names can differ
 * in supplier as well as size.
 */
function packCells(variant: VariantSpec): string | null {
  if (variant.pack === null || variant.packCandidates !== null) return null;
  return PACK_CELLS[variant.pack.slice(0, 4)] ?? null;
}

/** Transliteration table for the check digit — I, O, Q and 0 never appear. */
const TRANSLITERATION: Record<string, number> = {
  A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8,
  J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9,
  S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9,
};

const WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

/**
 * The digit position 9 should hold, per 49 CFR 565.15(c): a weighted sum of the
 * other sixteen characters, modulo 11, with 10 written as `X`.
 */
export function vinCheckDigit(raw: string): string | null {
  const vin = raw.trim().toUpperCase();
  if (!VIN_PATTERN.test(vin)) return null;

  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const char = vin[i]!;
    const value = char >= "0" && char <= "9" ? Number(char) : TRANSLITERATION[char];
    if (value === undefined) return null;
    sum += value * WEIGHTS[i]!;
  }
  const remainder = sum % 11;
  return remainder === 10 ? "X" : String(remainder);
}

/** Everything the VIN says about a car. Unreadable positions come back null. */
export function decodeVin(raw: string): VinDetails {
  const vin = raw.trim().toUpperCase();
  if (!VIN_PATTERN.test(vin)) return { vin, ...EMPTY };

  // Only Teslas are decoded. Another maker's VIN has a fourth character too, so
  // an unknown manufacturer means reporting nothing rather than guessing a model.
  const wmi = vin.slice(0, 3);
  const manufacturer = MANUFACTURERS[wmi];
  if (manufacturer === undefined) return { vin, ...EMPTY };

  const model = (MODEL_NAMES[vin[3] as TeslaModelCode] === undefined ? null : vin[3]) as TeslaModelCode | null;
  if (model === null) return { vin, ...EMPTY, wmi, manufacturer };

  const yearCode = vin[9]!;
  const letterIndex = YEAR_LETTERS.indexOf(yearCode);
  const digitIndex = YEAR_DIGITS.indexOf(yearCode);
  const modelYear =
    letterIndex !== -1
      ? YEAR_LETTER_BASE + letterIndex
      : digitIndex !== -1
        ? YEAR_DIGIT_BASE + digitIndex
        : null;

  const body = decodeBody(model, vin[4]!);
  const position6 = vin[5]!;
  // The Roadster shifts the layout by one: position 6 is its market, position 7
  // its restraints, and its chemistry is not encoded anywhere.
  const roadster = model === "R";
  const battery = roadster ? null : decodeBattery(vin[6]!, modelYear);
  const driveUnitCode = vin[7]!;
  const drive = roadster
    ? decodeRoadsterDriveUnit(driveUnitCode)
    : isTruck(model)
      ? decodeTruckDriveUnit(driveUnitCode)
      : decodeDriveUnit(model, driveUnitCode, modelYear);

  const checkDigit = vin[8]!;
  const serial = vin.slice(11).replace(/\D/g, "");
  const variant = roadster
    ? NO_SPEC
    : variantSpec(model, driveUnitCode, modelYear, vin[10]!, battery?.chemistry ?? null);

  return {
    vin,
    valid: true,
    wmi,
    manufacturer,
    model,
    modelName: MODEL_NAMES[model],
    modelYear,
    bodyType: body?.label ?? null,
    driveSide: body?.side ?? null,
    restraintSystem: roadster
      ? decodeRoadsterRestraint(vin[6]!)
      : isTruck(model)
        ? null
        : decodeRestraint(position6),
    gvwrClass: isTruck(model) ? decodeGvwr(position6) : null,
    roadsterRegion: roadster ? decodeRoadsterRegion(position6) : null,
    batteryType: battery?.label ?? null,
    batteryChemistry: battery?.chemistry ?? null,
    driveUnit: drive?.label ?? null,
    motorCount: drive?.motors ?? null,
    performance: drive?.performance ?? null,
    generation: pickEra(modelYear, GENERATIONS[model]),
    cells: roadster ? null : (packCells(variant) ?? decodeCells(model, vin[10]!, battery?.chemistry ?? null)),
    pack: variant.pack,
    usableWhenNewKwh: variant.usableWhenNewKwh,
    packCandidates: variant.packCandidates,
    motors: variant.motors,
    epaRangeMi: variant.epaRangeMi,
    wltpRangeKm: variant.wltpRangeKm,
    zeroTo60Mph: variant.zeroTo60Mph,
    zeroTo100Kmh: variant.zeroTo100Kmh,
    mcu: pickEra(modelYear, MCUS[model]),
    autopilotHardware: pickEra(modelYear, AUTOPILOT[model]),
    plant: PLANTS[vin[10]!] ?? null,
    buildPhase: BUILD_PHASES[vin[11]!] ?? null,
    serial: serial.length > 0 ? serial : null,
    checkDigit,
    checkDigitValid: checkDigit === vinCheckDigit(vin),
  };
}

/**
 * Whether the VIN says the car has an LFP pack, and null when it does not say.
 *
 * This is what spares the owner the "is this an LFP?" question. It is a strong
 * hint rather than a fact: Tesla encodes position 7 reliably on China-built
 * cars and has been inconsistent elsewhere, so the answer stays overridable.
 */
export function lfpFromVin(raw: string): boolean | null {
  const chemistry = decodeVin(raw).batteryChemistry;
  return chemistry === null ? null : chemistry === "lfp";
}

/** `identify()`'s `car_type` for a VIN, so an import can fill in `cars.model`. */
export function carTypeFromVin(raw: string): string | null {
  switch (decodeVin(raw).model) {
    case "S":
      return "models";
    case "3":
      return "model3";
    case "X":
      return "modelx";
    case "Y":
      return "modely";
    default:
      return null;
  }
}

/** First plausible VIN inside a file name or path, e.g. an export's zip name. */
export function findVin(text: string): string | null {
  for (const match of text.toUpperCase().matchAll(/[A-HJ-NPR-Z0-9]{17}/g)) {
    const info = decodeVin(match[0]);
    if (info.valid) return info.vin;
  }
  return null;
}

/**
 * What a car's VIN is worth showing as, top to bottom. Empty for a non-Tesla.
 *
 * The rating rows follow the unit of length: miles means the EPA figure and the
 * 0–60, kilometres the WLTP figure and the 0–100 — each falls back to the other
 * cycle when its own was never published for the variant.
 */
export function vinDetailRows(
  details: VinDetails,
  units?: { unitOfLength?: "km" | "mi" },
): { label: string; value: string }[] {
  if (!details.valid) return [];
  const rows: { label: string; value: string }[] = [];
  const add = (label: string, value: string | null | undefined) => {
    if (value) rows.push({ label, value });
  };

  const epa = details.epaRangeMi != null ? (["Range (EPA)", `≈ ${details.epaRangeMi} mi`] as const) : null;
  const wltp = details.wltpRangeKm != null ? (["Range (WLTP)", `≈ ${details.wltpRangeKm} km`] as const) : null;
  const to60 = details.zeroTo60Mph != null ? (["0–60 mph", `≈ ${details.zeroTo60Mph} s`] as const) : null;
  const to100 = details.zeroTo100Kmh != null ? (["0–100 km/h", `≈ ${details.zeroTo100Kmh} s`] as const) : null;
  const miles = units?.unitOfLength === "mi";
  const range = miles ? (epa ?? wltp) : (wltp ?? epa);
  const sprint = miles ? (to60 ?? to100) : (to100 ?? to60);

  add("Model", [details.modelYear, details.modelName].filter(Boolean).join(" "));
  add("Generation", details.generation);
  add("Drive unit", details.driveUnit);
  add("Motors", details.motors);
  add("Battery", details.batteryType);
  add("Pack", details.pack);
  add("Cells", details.cells);
  if (range) add(range[0], range[1]);
  if (sprint) add(sprint[0], sprint[1]);
  add("Autopilot", details.autopilotHardware);
  add("MCU", details.mcu);
  add("Body", [details.bodyType, details.driveSide].filter(Boolean).join(", "));
  add("Built in", details.plant);
  add("Build phase", details.buildPhase);
  add("GVWR", details.gvwrClass);
  add("Market", details.roadsterRegion);
  add("Serial", details.serial);
  return rows;
}
