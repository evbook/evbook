/**
 * One tyre's condition, decided the same way everywhere it is shown: the Health
 * page's tyre tile, the car card's condition chips, and the attention dot on the
 * Health entry of the nav. Every one of them goes through `tyreStatus`, so none
 * can call a tyre fine that another calls low.
 *
 * What the car itself says comes first. Tesla raises a soft warning when a tyre
 * is low and a hard warning when it is very low or losing air fast, and either
 * one decides the status outright. The thresholds below only add what the car
 * does not flag: a tyre that has drifted well under (or over) the pressure the
 * car recommends for its axle without yet tripping the car's own warning, which
 * sits about 25 % under — the floor FMVSS 138 sets for TPMS.
 *
 *   very low  hard warning, or under 75 % of the recommended pressure
 *   low       soft warning, or under 90 % of the recommended pressure
 *   high      over 120 % of the recommended pressure (a tyre is ~10 % up warm
 *             off a motorway, so anything short of that is just heat)
 *   fault     the car reported the other tyres but nothing for this one — a
 *             sensor that has stopped answering
 *   unknown   no reading, or a reading with neither a recommended pressure to
 *             compare it to nor a warning flag the car vouched for
 *   ok        everything else: a reading, and either a recommended pressure it
 *             is within the band of or the car's explicit "no warning"
 *
 * "unknown" is never shown as fine. A tyre the car has said nothing about is a
 * tyre nobody knows about.
 */

export type TyreCorner = "fl" | "fr" | "rl" | "rr";
export const TYRE_CORNERS: readonly TyreCorner[] = ["fl", "fr", "rl", "rr"];

export type TyreStatus = "ok" | "low" | "very-low" | "high" | "fault" | "unknown";

/** The fractions of the recommended pressure the statuses change at. */
export const TYRE_THRESHOLDS = {
  veryLowBelow: 0.75,
  lowBelow: 0.9,
  highAbove: 1.2,
} as const;

/** Statuses that ask the owner to go and look at a tyre. */
const ATTENTION: ReadonlySet<TyreStatus> = new Set(["low", "very-low", "high", "fault"]);

export function needsAttention(status: TyreStatus): boolean {
  return ATTENTION.has(status);
}

export interface TyreInput {
  /** Bar, or null when the car did not report it. Never 0 for "unknown". */
  pressureBar: number | null;
  /** The car's recommended cold pressure for this tyre's axle, in bar. */
  recommendedBar: number | null;
  softWarning: boolean | null;
  hardWarning: boolean | null;
}

export interface TyreReadingLike {
  fl: number | null;
  fr: number | null;
  rl: number | null;
  rr: number | null;
  rcpFront: number | null;
  rcpRear: number | null;
  softFl: boolean | null;
  softFr: boolean | null;
  softRl: boolean | null;
  softRr: boolean | null;
  hardFl: boolean | null;
  hardFr: boolean | null;
  hardRl: boolean | null;
  hardRr: boolean | null;
}

/**
 * The status of one tyre. `siblingsReported` says whether the car reported a
 * pressure for any of the other three in the same reading — the difference
 * between a car that said nothing (unknown) and a sensor that went quiet (fault).
 */
export function tyreStatus(input: TyreInput, siblingsReported = false): TyreStatus {
  const { pressureBar, recommendedBar, softWarning, hardWarning } = input;
  if (hardWarning === true) return "very-low";
  if (softWarning === true) return "low";
  if (pressureBar == null) return siblingsReported ? "fault" : "unknown";

  if (recommendedBar != null && recommendedBar > 0) {
    const ratio = pressureBar / recommendedBar;
    if (ratio < TYRE_THRESHOLDS.veryLowBelow) return "very-low";
    if (ratio < TYRE_THRESHOLDS.lowBelow) return "low";
    if (ratio > TYRE_THRESHOLDS.highAbove) return "high";
    return "ok";
  }
  // No recommended pressure to measure against: only the car's own explicit
  // "no warning" can vouch for the tyre.
  return softWarning === false ? "ok" : "unknown";
}

export interface TyreState {
  corner: TyreCorner;
  pressureBar: number | null;
  recommendedBar: number | null;
  status: TyreStatus;
}

const SOFT = { fl: "softFl", fr: "softFr", rl: "softRl", rr: "softRr" } as const;
const HARD = { fl: "hardFl", fr: "hardFr", rl: "hardRl", rr: "hardRr" } as const;

/** All four tyres of one reading, in fl, fr, rl, rr order. */
export function tyreStates(reading: TyreReadingLike | null): TyreState[] {
  return TYRE_CORNERS.map((corner) => {
    if (reading == null) {
      return { corner, pressureBar: null, recommendedBar: null, status: "unknown" as const };
    }
    const recommendedBar = corner[0] === "f" ? reading.rcpFront : reading.rcpRear;
    const siblingsReported = TYRE_CORNERS.some((other) => other !== corner && reading[other] != null);
    return {
      corner,
      pressureBar: reading[corner],
      recommendedBar,
      status: tyreStatus(
        {
          pressureBar: reading[corner],
          recommendedBar,
          softWarning: reading[SOFT[corner]],
          hardWarning: reading[HARD[corner]],
        },
        siblingsReported,
      ),
    };
  });
}

/** Whether any tyre of a reading asks for attention — what the nav dot shows. */
export function tyresNeedAttention(reading: TyreReadingLike | null): boolean {
  return tyreStates(reading).some((tyre) => needsAttention(tyre.status));
}

export const TYRE_LABELS: Record<TyreCorner, string> = {
  fl: "Front left",
  fr: "Front right",
  rl: "Rear left",
  rr: "Rear right",
};

export const TYRE_STATUS_LABELS: Record<TyreStatus, string> = {
  ok: "OK",
  low: "Low",
  "very-low": "Very low",
  high: "High",
  fault: "Sensor fault",
  unknown: "Not reported",
};
