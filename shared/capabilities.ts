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
 * Adding a provider is one entry in `CAPABILITIES` (the `Record` will not
 * compile without it); the card and Settings follow. Declare a reading only
 * when the provider's API can actually give it, and a command only when EVBook
 * sends it: every read-only provider declares `commands: []`. A new reading id
 * comes with the first provider that reports it, never ahead of one.
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
 * - `sleep`: stop polling so the car can fall asleep. Declare it only where
 *   EVBook's own polling keeps the car awake, so that backing off is what lets
 *   it sleep (a Tesla). A car that sleeps whatever EVBook does, or that reading
 *   never wakes, has nothing for it to protect. It is what the idle and sleep
 *   settings tune.
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

/** What an unknown provider gets: nothing to show and nothing to send. */
export const NO_CAPABILITIES: Capabilities = { readings: [], commands: [], features: [] };

/**
 * A provider's declaration. An unknown provider gets `NO_CAPABILITIES`, never
 * Tesla's: falling back to Tesla would offer a car of another make a wake, a
 * sleep and free supercharging it does not have.
 */
export function capabilitiesOf(provider: Provider | string | null | undefined): Capabilities {
  return Object.hasOwn(CAPABILITIES, provider ?? "") ? CAPABILITIES[provider as Provider] : NO_CAPABILITIES;
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
 * of the rest stays a row underneath. A provider that declares fewer gets fewer
 * figures, not dashes: a car that only reports its odometer shows that one.
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
 * The figures for a declaration in a mode: the first `FIGURE_COUNT` readings of
 * the mode's priority list that it declares, between none and `FIGURE_COUNT`.
 * Whether a value is present right now does not enter into it, so the layout
 * only changes with the mode.
 */
export function figuresOf(capabilities: Capabilities, mode: CardMode): ReadingId[] {
  return FIGURE_PRIORITY[mode].filter((reading) => capabilities.readings.includes(reading)).slice(0, FIGURE_COUNT);
}

/** `figuresOf` for a provider's declaration. */
export function figuresFor(provider: Provider | string | null | undefined, mode: CardMode): ReadingId[] {
  return figuresOf(capabilitiesOf(provider), mode);
}
