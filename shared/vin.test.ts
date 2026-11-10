import { describe, expect, it } from "bun:test";
import { carTypeFromVin, decodeVin, findVin, lfpFromVin, vinCheckDigit, vinDetailRows } from "./vin";

describe("decoding a whole VIN", () => {
  it("reads every position of a Model S Plaid", () => {
    expect(decodeVin("5YJSA1E62NF016329")).toEqual({
      vin: "5YJSA1E62NF016329",
      valid: true,
      wmi: "5YJ",
      manufacturer: "Tesla, Inc. — USA",
      model: "S",
      modelName: "Model S",
      modelYear: 2022,
      bodyType: "5-door hatchback",
      driveSide: "LHD",
      restraintSystem: "Type 2 manual belts (front, rear x3), front airbags, side inflatable restraints, knee airbags",
      gvwrClass: null,
      roadsterRegion: null,
      batteryType: "Lithium-ion battery",
      batteryChemistry: "nickel",
      driveUnit: "P2 tri motor",
      motorCount: 3,
      performance: true,
      generation: "Palladium (2021 redesign)",
      cells: "18650 cylindrical — Panasonic NCA",
      pack: null,
      usableWhenNewKwh: 95,
      packCandidates: null,
      motors: "Three permanent-magnet motors — ≈750 kW total (Plaid)",
      epaRangeMi: 396,
      wltpRangeKm: 600,
      zeroTo60Mph: 2.0,
      zeroTo100Kmh: 2.1,
      mcu: "MCU3 — AMD Ryzen",
      autopilotHardware: "HW3",
      plant: "Fremont, California, USA",
      buildPhase: null,
      serial: "016329",
      checkDigit: "2",
      checkDigitValid: true,
    });
  });

  it("reads a right-hand-drive Model 3 built in Shanghai", () => {
    expect(decodeVin("LRW3F7EB9MC123456")).toMatchObject({
      valid: true,
      manufacturer: "Tesla — China",
      model: "3",
      modelName: "Model 3",
      modelYear: 2021,
      bodyType: "4-door sedan",
      driveSide: "RHD",
      batteryChemistry: "nickel",
      driveUnit: "Dual motor — Long Range",
      motorCount: 2,
      performance: false,
      pack: "BT38 (75 kWh, 5/5C) or BT43 (79 kWh, 5L)",
      // Shanghai ran the BT38 for most of 2021, so the figures are its; the
      // VIN cannot split the two packs, but the owner can — each side carries
      // its own as-new figure for the picker.
      usableWhenNewKwh: 72,
      packCandidates: [
        { pack: "BT38 — 75 kWh (5/5C)", usableWhenNewKwh: 72 },
        { pack: "BT43 — 79 kWh (5L)", usableWhenNewKwh: 75 },
      ],
      cells: "2170 cylindrical — LG NMC",
      wltpRangeKm: 580,
      plant: "Shanghai, China",
      serial: "123456",
      checkDigitValid: true,
    });
  });

  it("names all three packs Fremont fitted to the 2021 Long Range", () => {
    // The BT42 took over in February 2021 and is most of the year, but the BT37
    // ran on until November and the cars built for Europe carry the LG BT38 —
    // one drive character, one year, one plant, three packs.
    expect(decodeVin("5YJ3E1EB7MF016329")).toMatchObject({
      valid: true,
      modelYear: 2021,
      plant: "Fremont, California, USA",
      driveUnit: "Dual motor — Long Range",
      pack: "BT42 — 82 kWh (3L), or BT37/BT38 — 75 kWh on cars built before mid-2021",
      usableWhenNewKwh: 78,
      packCandidates: [
        { pack: "BT42 — 82 kWh (3L)", usableWhenNewKwh: 78 },
        { pack: "BT37 — 75 kWh (1/1C)", usableWhenNewKwh: 74 },
        { pack: "BT38 — 75 kWh (5/5C)", usableWhenNewKwh: 72 },
      ],
      // An unresolved pack leaves the cells to the factory's inference.
      cells: "2170 cylindrical — Panasonic NCA",
      epaRangeMi: 353,
    });
    // A year later the BT42 is the only pack left, and nothing to pick between.
    expect(decodeVin("5YJ3E1EB7NF016329")).toMatchObject({
      modelYear: 2022,
      pack: "BT42 — 82 kWh (3L)",
      usableWhenNewKwh: 78,
      packCandidates: null,
      cells: "2170L cylindrical — Panasonic NCA",
    });
  });

  it("reads a 2023 Shanghai Model Y Performance under the re-lettered drive code", () => {
    // Position 8 is L, the character that replaced F from mid-2022 — the pack
    // details must resolve the same way they would for an F.
    expect(decodeVin("LRWYHCEL5PC720254")).toMatchObject({
      valid: true,
      manufacturer: "Tesla — China",
      model: "Y",
      modelYear: 2023,
      driveSide: "RHD",
      driveUnit: "Dual motor — Performance",
      performance: true,
      pack: "BT43 — 79 kWh (5L)",
      usableWhenNewKwh: 75,
      packCandidates: null,
      motors: "Front induction ≈150 kW + rear permanent-magnet ≈220 kW",
      wltpRangeKm: 514,
      zeroTo100Kmh: 3.7,
      plant: "Shanghai, China",
      serial: "720254",
      checkDigitValid: true,
    });
  });

  it("reads a performance Model Y built in Berlin", () => {
    expect(decodeVin("XP7YGCEFXPB123456")).toMatchObject({
      valid: true,
      manufacturer: "Tesla — Germany",
      model: "Y",
      modelYear: 2023,
      bodyType: "Class D MPV, 5-door",
      driveSide: "LHD",
      driveUnit: "Dual motor — Performance",
      motorCount: 2,
      performance: true,
      pack: "BT43 — 79 kWh (5L)",
      motors: "Front induction ≈150 kW + rear permanent-magnet ≈220 kW",
      wltpRangeKm: 514,
      zeroTo100Kmh: 3.7,
      plant: "Berlin-Brandenburg, Germany",
    });
  });

  it("reads a Cybertruck's weight class and triple motor", () => {
    expect(decodeVin("7G2CEHED7RA123456")).toMatchObject({
      valid: true,
      model: "C",
      modelName: "Cybertruck",
      modelYear: 2024,
      bodyType: "Truck",
      gvwrClass: "Class H — 9,001-10,000 lbs",
      restraintSystem: null,
      driveUnit: "Dual motor — standard (Cybertruck)",
      motorCount: 2,
      plant: "Austin, Texas, USA",
    });
    expect(decodeVin("7G2CEHEE0RA123456").driveUnit).toBe("Triple motor — performance (Cybertruck)");
  });

  it("shifts a position for the Roadster, whose layout differs", () => {
    // Region sits where a car has its restraints, restraints where a car has
    // its battery, and the chemistry is not encoded at all.
    expect(decodeVin("SFZRE2A129P123456")).toMatchObject({
      valid: true,
      model: "R",
      modelName: "Roadster",
      modelYear: 2009,
      bodyType: "Convertible",
      roadsterRegion: "Europe (LHD)",
      restraintSystem: "Type 2 USA seat belts, dual airbags",
      batteryType: null,
      batteryChemistry: null,
      driveUnit: "Tesla M6B motor",
    });
  });

  it("names the build phase when position 12 is a letter, not a serial digit", () => {
    expect(decodeVin("5YJSA1E62NFP16329")).toMatchObject({
      buildPhase: "Production vehicle",
      serial: "16329",
    });
    expect(decodeVin("5YJSA1E62NF016329").buildPhase).toBeNull();
  });
});

describe("model year", () => {
  const withYearCode = (code: string) => decodeVin(`5YJSA1E62${code}F016329`).modelYear;

  it("maps the letter codes from 2010 on, skipping I, O, Q and U", () => {
    expect(withYearCode("A")).toBe(2010);
    expect(withYearCode("H")).toBe(2017);
    expect(withYearCode("J")).toBe(2018);
    expect(withYearCode("N")).toBe(2022);
    expect(withYearCode("P")).toBe(2023);
    expect(withYearCode("S")).toBe(2025);
    expect(withYearCode("Y")).toBe(2030);
  });

  it("maps the digit codes to the Roadster years", () => {
    expect(withYearCode("8")).toBe(2008);
    expect(withYearCode("9")).toBe(2009);
  });

  it("leaves an unassigned code null rather than guessing", () => {
    expect(withYearCode("1")).toBeNull();
  });

  it("decides between the readings a character has had", () => {
    // Position 8 `C` is a Model 3 performance drive unit from 2020, and a Model
    // S base motor before that.
    expect(decodeVin("5YJ3E1EC0NF016329").driveUnit).toBe("Dual motor — Performance");
    expect(decodeVin("5YJSA1EC0HF016329").driveUnit).toBe("Base A/C motor, tier 2 battery (31-40 kWh)");
  });
});

describe("battery chemistry", () => {
  it("reads position 7 `F` as an LFP pack", () => {
    expect(decodeVin("LRW3E7FA8MC123456")).toMatchObject({
      batteryType: "Lithium iron phosphate (LFP) battery",
      batteryChemistry: "lfp",
      driveUnit: "Single motor — Standard or Long Range",
    });
    expect(lfpFromVin("LRW3E7FA8MC123456")).toBe(true);
  });

  it("reads the lithium-ion codes as not-LFP", () => {
    expect(lfpFromVin("LRW3F7EB9MC123456")).toBe(false);
    expect(decodeVin("5YJSA1H62NF016329").batteryType).toBe("Lithium-ion battery — high capacity");
    expect(decodeVin("5YJSA1S62NF016329").batteryType).toBe("Lithium-ion battery — standard capacity");
    expect(decodeVin("5YJSA1V62NF016329").batteryType).toBe("Lithium-ion battery — ultra high capacity");
  });

  it("reads the pre-2015 codes as chargers, from before LFP existed", () => {
    expect(decodeVin("5YJSA1C62DF016329")).toMatchObject({
      batteryType: "10 kW charger, with DC fast charge",
      batteryChemistry: "nickel",
    });
    expect(lfpFromVin("5YJSA1C62DF016329")).toBe(false);
  });

  it("says nothing when the VIN does not say", () => {
    expect(lfpFromVin("SFZRE2A129P123456")).toBeNull(); // a Roadster
    expect(lfpFromVin("WBA3A5C55DF000001")).toBeNull(); // not a Tesla
    // `F` predates the LFP era on a 2014 car, so it stays unread.
    expect(decodeVin("5YJSA1F62EF016329").batteryType).toBeNull();
  });
});

describe("eras inferred from the model year", () => {
  it("names both sides of a year a changeover fell inside", () => {
    expect(decodeVin("5YJSA1E62KF016329")).toMatchObject({
      modelYear: 2019,
      generation: "Facelift or Raven (changed April 2019)",
      mcu: "MCU2 — Intel Atom",
      autopilotHardware: "HW2.5 or HW3 (changed mid-2019)",
    });
  });

  it("knows the earliest Model S predates Autopilot", () => {
    expect(decodeVin("5YJSA1C62DF016329")).toMatchObject({
      modelYear: 2013,
      generation: "Original",
      mcu: "MCU1 — Nvidia Tegra",
      autopilotHardware: "None — built before Autopilot",
      cells: "18650 cylindrical — Panasonic NCA",
    });
  });

  it("recognises a Highland Model 3", () => {
    expect(decodeVin("5YJ3E1EA0RF016329")).toMatchObject({
      modelYear: 2024,
      generation: "Highland",
      mcu: "AMD Ryzen",
      autopilotHardware: "HW4",
      // The pack, not the plant, says the cell is the taller 2170L.
      cells: "2170L cylindrical — Panasonic NCA",
    });
  });

  it("follows the factory to the cell supplier", () => {
    // Berlin runs LG NMC 2170s; Austin built 2170 and 4680 packs side by side.
    expect(decodeVin("XP7YGCEE0TB123456")).toMatchObject({
      modelYear: 2026,
      generation: "Juniper",
      cells: "2170 cylindrical — LG NMC (M50 modules)",
    });
    expect(decodeVin("7SAYGDEE9NA123456").cells).toBe("2170 cylindrical, or 4680 structural pack — varies by trim");
  });

  it("says nothing for the models the tables do not cover", () => {
    expect(decodeVin("SFZRE2A129P123456")).toMatchObject({
      generation: null,
      cells: null,
      mcu: null,
      autopilotHardware: null,
    });
  });
});

describe("check digit", () => {
  it("computes the digit position 9 should hold", () => {
    expect(vinCheckDigit("5YJSA1E62NF016329")).toBe("2");
    expect(vinCheckDigit("LRW3F7EB9MC123456")).toBe("9");
    expect(vinCheckDigit("XP7YGCEF0PB123456")).toBe("X"); // a remainder of 10
  });

  it("flags a VIN whose check digit does not match, without rejecting it", () => {
    const info = decodeVin("5YJSA1E60NF016329");
    expect(info.valid).toBe(true);
    expect(info.checkDigit).toBe("0");
    expect(info.checkDigitValid).toBe(false);
  });

  it("has nothing to compute for a malformed VIN", () => {
    expect(vinCheckDigit("TOOSHORT")).toBeNull();
  });
});

describe("what is not a Tesla VIN", () => {
  const nothingRead = { valid: false, model: null, modelYear: null, plant: null, batteryChemistry: null };

  it("rejects another maker, the wrong length, and the letters a VIN cannot hold", () => {
    expect(decodeVin("WBA3A5C55DF000001")).toMatchObject(nothingRead); // a BMW
    expect(decodeVin("TOOSHORT")).toMatchObject(nothingRead);
    expect(decodeVin("LRW3F7EB9MC12345I")).toMatchObject(nothingRead); // I is not a VIN character
  });

  it("reports the manufacturer but no car when the model letter is unknown", () => {
    expect(decodeVin("5YJZA1E62NF016329")).toMatchObject({
      valid: false,
      manufacturer: "Tesla, Inc. — USA",
      model: null,
    });
  });

  it("normalises case and whitespace", () => {
    expect(decodeVin(" lrw3f7eb9mc123456 ").vin).toBe("LRW3F7EB9MC123456");
    expect(decodeVin(" lrw3f7eb9mc123456 ").valid).toBe(true);
  });
});

describe("using a VIN elsewhere", () => {
  it("maps to the car_type identify() expects", () => {
    expect(carTypeFromVin("LRW3F7EB9MC123456")).toBe("model3");
    expect(carTypeFromVin("5YJYGDEE0LF000001")).toBe("modely");
    expect(carTypeFromVin("WBA3A5C55DF000001")).toBeNull();
  });

  it("finds a VIN inside an export's file name", () => {
    expect(findVin("LRW3F7EB9MC123456.zip")).toBe("LRW3F7EB9MC123456");
    expect(findVin("tessie/exports/lrw3f7eb9mc123456-2026-06.zip")).toBe("LRW3F7EB9MC123456");
    expect(findVin("tessie-export.zip")).toBeNull();
  });

  it("lists the details worth showing, skipping what the VIN did not say", () => {
    expect(vinDetailRows(decodeVin("LRW3E7FA8MC123456"))).toEqual([
      { label: "Model", value: "2021 Model 3" },
      { label: "Generation", value: "2021 refresh" },
      { label: "Drive unit", value: "Single motor — Standard or Long Range" },
      { label: "Motors", value: "Rear permanent-magnet, ≈200 kW" },
      { label: "Battery", value: "Lithium iron phosphate (LFP) battery" },
      { label: "Pack", value: "BTF0 — 55 kWh (6C)" },
      { label: "Cells", value: "Prismatic LFP — CATL" },
      { label: "Range (WLTP)", value: "≈ 468 km" },
      { label: "0–100 km/h", value: "≈ 5.6 s" },
      { label: "Autopilot", value: "HW3" },
      { label: "MCU", value: "Intel Atom" },
      { label: "Body", value: "4-door sedan, LHD" },
      { label: "Built in", value: "Shanghai, China" },
      { label: "Serial", value: "123456" },
    ]);
    expect(vinDetailRows(decodeVin("WBA3A5C55DF000001"))).toEqual([]);
  });

  it("follows the unit of length to the rating cycle it quotes", () => {
    // A Fremont Model 3 Performance has both cycles on record.
    const both = decodeVin("5YJ3E1EC0NF016329");
    const km = vinDetailRows(both);
    expect(km).toContainEqual({ label: "Range (WLTP)", value: "≈ 547 km" });
    expect(km).toContainEqual({ label: "0–100 km/h", value: "≈ 3.3 s" });
    const mi = vinDetailRows(both, { unitOfLength: "mi" });
    expect(mi).toContainEqual({ label: "Range (EPA)", value: "≈ 315 mi" });
    expect(mi).toContainEqual({ label: "0–60 mph", value: "≈ 3.1 s" });

    // A China-only variant was never EPA-rated: miles fall back to WLTP.
    const cn = vinDetailRows(decodeVin("LRW3F7EB9MC123456"), { unitOfLength: "mi" });
    expect(cn).toContainEqual({ label: "Range (WLTP)", value: "≈ 580 km" });
  });
});
