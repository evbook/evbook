import type { Provider } from "./api-types";

/**
 * What each provider can report and do, declared once, so the app asks "can this
 * car…?" instead of "is this a Volvo?".
 *
 * A declaration is about what the provider's API *can* give, not what a car
 * happens to have sent in its last poll. That is what keeps the layouts below
 * stable: a Tesla asleep drops its temperatures for a while, and its figures
 * read "–" rather than reshuffling until it wakes.
 *
 * Adding a make is one entry in `CAPABILITIES`; the card and Settings follow.
 */

/**
 * The readings the car card can set as a figure or a row. Named for what the
 * owner reads, not for a vendor's field.
 */
export type ReadingId =
  | "speed"
  | "power"
  | "outsideTemp"
  | "insideTemp"
  | "odometer"
  | "chargeLimit"
  | "service"
  | "chargerPower"
  | "timeToFull"
  | "energyAdded";

/**
 * What EVBook can ask of the car, or of its own logger on the car's behalf.
 *
 * - `wake`: wake a sleeping car.
 * - `sleep`: stop polling so the car can fall asleep — the car has a sleep state
 *   worth protecting. It is what the idle and sleep settings tune.
 * - `navigate`: send a destination to the car's navigation.
 */
export type Command = "wake" | "sleep" | "navigate";

/** What a provider brings that is neither a reading nor a command. */
export type Feature =
  /** A charging network the car may charge on for free (Tesla's Superchargers). */
  "freeSupercharging";

export interface Capabilities {
  readings: readonly ReadingId[];
  commands: readonly Command[];
  features: readonly Feature[];
}

export const CAPABILITIES: Record<Provider, Capabilities> = {
  tesla: {
    readings: [
      "speed",
      "power",
      "outsideTemp",
      "insideTemp",
      "odometer",
      "chargeLimit",
      "chargerPower",
      "timeToFull",
      "energyAdded",
    ],
    commands: ["wake", "sleep", "navigate"],
    features: ["freeSupercharging"],
  },
  /*
    Connected Vehicle v2 and Energy v2. No temperatures: the external-temperature
    endpoint is gone from v2 and the Extended Vehicle API that had it shut down at
    the end of 2025. No speed or power either — a poll a minute or more apart
    cannot say how fast the car is going. Read-only: EVBook sends a Volvo no
    commands, and a Volvo has no sleep for EVBook to protect.
  */
  volvo: {
    readings: ["odometer", "chargeLimit", "service", "chargerPower", "timeToFull", "energyAdded"],
    commands: [],
    features: [],
  },
};

/**
 * A provider's declaration. Unknown or missing means Tesla: summaries and cars
 * from before Volvo carry no provider, and every one of them is a Tesla.
 */
export function capabilitiesOf(provider: Provider | string | null | undefined): Capabilities {
  return CAPABILITIES[provider as Provider] ?? CAPABILITIES.tesla;
}

export function canReport(provider: Provider | string | null | undefined, reading: ReadingId): boolean {
  return capabilitiesOf(provider).readings.includes(reading);
}

export function canDo(provider: Provider | string | null | undefined, command: Command): boolean {
  return capabilitiesOf(provider).commands.includes(command);
}

export function hasFeature(provider: Provider | string | null | undefined, feature: Feature): boolean {
  return capabilitiesOf(provider).features.includes(feature);
}

/** What the car is doing, as far as the card's figures care. */
export type CardMode = "parked" | "driving" | "charging";

export function cardMode(state: string | null | undefined): CardMode {
  return state === "charging" ? "charging" : state === "driving" ? "driving" : "parked";
}

/**
 * Per mode, the readings worth leading with, most wanted first. The card sets the
 * first `FIGURE_COUNT` its provider declares as figures; whatever the card shows
 * of the rest stays a row underneath.
 *
 * Charging is about how fast and how long, driving about speed and draw, and a
 * parked car about the weather it is sitting in. Where a provider cannot say
 * those, the odometer, the charge limit and the next service are the next
 * things an owner looks up.
 */
export const FIGURE_PRIORITY: Record<CardMode, readonly ReadingId[]> = {
  charging: ["chargerPower", "timeToFull", "energyAdded", "chargeLimit", "odometer"],
  driving: ["speed", "power", "outsideTemp", "odometer", "chargeLimit", "service"],
  parked: ["outsideTemp", "insideTemp", "odometer", "chargeLimit", "service"],
};

export const FIGURE_COUNT = 3;

/**
 * The figures for a provider in a mode: the first `FIGURE_COUNT` readings of the
 * mode's priority list that the provider declares. Whether a value is present
 * right now does not enter into it, so the layout only changes with the mode.
 */
export function figuresFor(provider: Provider | string | null | undefined, mode: CardMode): ReadingId[] {
  const declared = capabilitiesOf(provider).readings;
  return FIGURE_PRIORITY[mode].filter((reading) => declared.includes(reading)).slice(0, FIGURE_COUNT);
}
