/** DTOs shared between the Worker API and the SPA. */

import type { CurrencyCode } from "./currency";
import type { NumberRange, TimeSpan } from "./uncertainty";
import type { SurveyConfig, TelemetryLevel } from "./telemetry";
import type { ReleaseChannel } from "./version";
import type { TyreCorner, TyreStatus } from "./tyres";

export type { NumberRange, TimeSpan } from "./uncertainty";
export type { TyreCorner, TyreStatus } from "./tyres";

export interface SessionInfo {
  authenticated: boolean;
  setupRequired: boolean; // APP_PASSWORD secret not configured yet
  tesla: TeslaAuthStatus | null; // null unless authenticated
  /** Fixture data, no real car behind it — the shell shows a Demo badge. */
  demo?: boolean;
}

export interface TeslaAuthStatus {
  signedIn: boolean;
  expiresAt: number | null;
  lastRefreshAt: number | null;
  lastError: string | null;
}

export interface CarDto {
  id: number;
  name: string | null;
  model: string | null;
  trimBadging: string | null;
  vin: string;
  efficiency: number | null;
  /**
   * Whether this car is polled — the "Log this car" switch, mirrored onto the
   * vehicle itself so a list of cars can be shown as a list of *live* cars
   * without asking after each one's settings. A car with no settings row at all
   * counts as not logged, which is what the cron that starts the loggers does.
   *
   * It says nothing about the history: a car imported from another service is
   * logged off and still has years of drives to read.
   */
  logged: boolean;
  /**
   * Whether the car's latest tyre reading has a tyre that is low, very low, high
   * or whose sensor went quiet (see `shared/tyres.ts`). Carried on the car list,
   * which every page already has, so the nav can mark Health without a request
   * of its own. False when nothing has been read — unknown is not a warning.
   */
  tyreAttention: boolean;
}

/** One tyre now: what the car last read, what it recommends, and the verdict. */
export interface TyreStateDto {
  corner: TyreCorner;
  /** Bar; null when the car did not report this tyre. */
  pressureBar: number | null;
  /** The recommended cold pressure for this tyre's axle, bar. */
  recommendedBar: number | null;
  status: TyreStatus;
}

export type TyreRange = "7d" | "30d" | "12m";

/**
 * One bucket of the pressure history. Every bucket in the window is present, in
 * order; a bucket nothing was read in has nulls throughout, which is where a
 * chart line breaks. Values are the mean of the readings in the bucket, bar.
 */
export interface TyrePressurePointDto {
  at: number;
  fl: number | null;
  fr: number | null;
  rl: number | null;
  rr: number | null;
  recommendedFront: number | null;
  recommendedRear: number | null;
}

export interface TyrePressureDto {
  carId: number;
  range: TyreRange;
  from: number;
  to: number;
  bucketMs: number;
  /** The newest reading on record, whenever it was; `at` is null if there is none. */
  current: { at: number | null; tyres: TyreStateDto[] };
  points: TyrePressurePointDto[];
}

/**
 * Live state of one car. Mirrors the projection TeslaMate publishes over MQTT
 * so ecosystem tools have a familiar shape. Distances are km, temps °C.
 */
export interface CarSummaryDto {
  carId: number;
  /** driving | charging | updating | falling_asleep | online | asleep | offline | unknown */
  state: string;
  since: number | null;
  healthy: boolean;

  batteryLevel: number | null;
  usableBatteryLevel: number | null;
  chargeLimitSoc: number | null;
  idealBatteryRangeKm: number | null;
  ratedBatteryRangeKm: number | null;
  estBatteryRangeKm: number | null;

  odometerKm: number | null;
  speedKmh: number | null;
  power: number | null;
  shiftState: string | null;
  latitude: number | null;
  longitude: number | null;
  heading: number | null;

  insideTemp: number | null;
  outsideTemp: number | null;
  /** What the climate control is set to, as against what the cabin actually is. */
  driverTempSetting: number | null;
  isClimateOn: boolean | null;
  isPreconditioning: boolean | null;

  locked: boolean | null;
  sentryMode: boolean | null;
  isUserPresent: boolean | null;
  doorsOpen: boolean;
  trunkOpen: boolean;
  windowsOpen: boolean;

  chargingState: string | null;
  chargerPower: number | null;
  /**
   * What the charger is actually delivering. Together with the phase count this is
   * how you tell a 1-phase 16 A socket from a 3-phase one without knowing what you
   * plugged into — the difference between a full pack by morning and half of one.
   */
  chargerVoltage: number | null;
  chargerCurrent: number | null;
  chargerPhases: number | null;
  chargeEnergyAdded: number | null;
  timeToFullCharge: number | null;
  chargePortDoorOpen: boolean | null;

  version: string | null;
  updateAvailable: boolean;
  updateVersion: string | null;

  tpmsPressureFl: number | null;
  tpmsPressureFr: number | null;
  tpmsPressureRl: number | null;
  tpmsPressureRr: number | null;
  tpmsSoftWarningFl: boolean | null;
  tpmsSoftWarningFr: boolean | null;
  tpmsSoftWarningRl: boolean | null;
  tpmsSoftWarningRr: boolean | null;
  /** The four tyres in fl, fr, rl, rr order, with their status from `shared/tyres.ts`. */
  tyres: TyreStateDto[];

  /**
   * The car's own timestamp for the snapshot the values above came from. The
   * snapshot outlives the state that produced it — an asleep car still shows
   * its last readings — so this is what "as of when" means, where lastFetchAt
   * only says when the logger last got any answer at all.
   */
  dataAt: number | null;

  doorDfOpen: boolean | null;
  doorPfOpen: boolean | null;
  doorDrOpen: boolean | null;
  doorPrOpen: boolean | null;
  windowFdOpen: boolean | null;
  windowFpOpen: boolean | null;
  windowRdOpen: boolean | null;
  windowRpOpen: boolean | null;

  /** Range gained per hour of charging, converted from Tesla's mph figure. */
  chargeRateKmh: number | null;
  connChargeCable: string | null;
  batteryHeater: boolean | null;
  cabinOverheatProtection: string | null;
  copActivelyCooling: boolean | null;
  passengerTempSetting: number | null;
  autoSeatClimateLeft: boolean | null;
  autoSeatClimateRight: boolean | null;
  autoSteeringWheelHeat: boolean | null;
  dashcamState: string | null;
  scheduledChargingPending: boolean | null;
  tripCharging: boolean | null;

  /** The trip the car is navigating; null when the nav is idle. */
  activeRoute: {
    destination: string | null;
    minutesToArrival: number | null;
    distanceKm: number | null;
    trafficMinutesDelay: number | null;
    /** Predicted state of charge on arrival, percent. */
    energyAtArrival: number | null;
  } | null;

  /** Why the car cannot fall asleep right now, if anything. */
  sleepBlocker: string | null;
  lastFetchAt: number | null;
  lastError: string | null;
}

export interface GlobalSettingsDto {
  unitOfLength: "km" | "mi";
  unitOfTemperature: "C" | "F";
  unitOfPressure: "bar" | "psi";
  currency: CurrencyCode;
  preferredRange: "ideal" | "rated";
  timezone: string;
  /**
   * Read-only: whether someone has picked `timezone`. False means it is still
   * the install's UTC default, which the web app replaces with the browser's
   * zone on its first visit.
   */
  timezoneChosen: boolean;
  geocodeLanguage: string;
  /** What the instance may report about itself (shared/telemetry.ts). */
  telemetryLevel: TelemetryLevel;
  /**
   * Where new glovebox uploads go: the database (the default, nothing to set
   * up) or the bucket below. Existing documents stay where they were uploaded.
   */
  documentStorage: DocumentStorage;
  /** Read-only: the bucket this deployment has, or null (R2 not enabled on Cloudflare). */
  documentBucket: DocumentBucketKind | null;
}

export type DocumentStorage = "database" | "bucket";

/** An R2 bucket on Cloudflare, a directory of files on a VPS. */
export type DocumentBucketKind = "r2" | "files";

/**
 * The survey the client should offer, or null — already answered, dismissed,
 * sampled out, telemetry off, or simply no survey for this version. When to
 * put it on screen is the client's business (lib/telemetryPrompts.ts).
 */
export interface SurveyStateDto {
  survey: SurveyConfig | null;
}

/** What the client sends back; `answers` only when `status` is "answered". */
export interface SurveyResponseDto {
  surveyId: string;
  status: "answered" | "dismissed";
  answers?: Record<string, string | number>;
}

/**
 * What version the instance is running and what the newest release is called.
 *
 * `latest` is what the last check found, not what is running: it stays put
 * between checks, and is null until the first one has happened (or forever, on
 * an instance whose owner has turned checking off).
 */
export interface VersionInfoDto {
  /** The running build. */
  current: string;
  /** The release channel this instance follows. */
  channel: ReleaseChannel;
  /** Newest version seen on that channel, or null if nothing has been seen. */
  latest: string | null;
  /** Where to read about `latest`; null whenever `latest` is. */
  releaseUrl: string | null;
  /** When the check last ran, successfully or not. Null if it never has. */
  checkedAt: number | null;
  updateAvailable: boolean;
  /** The deployment has turned the check off, so `latest` will stay null. */
  checkDisabled: boolean;
  /**
   * This instance can install updates itself: a GitHub token is configured, so
   * the Install button dispatches the repository's deploy workflow instead of
   * the Settings page only reciting the two commands.
   */
  canInstall: boolean;
}

/** The most recent run of the deploy workflow, as GitHub reports it. */
export interface UpdateRunDto {
  /** queued | in_progress | completed (GitHub may add more). */
  status: string;
  /** success | failure | cancelled … — null until the run completes. */
  conclusion: string | null;
  /** The run on GitHub, for following along or reading a failure. */
  url: string;
  startedAt: number;
}

export interface CarSettingsDto {
  carId: number;
  enabled: boolean;
  suspendMin: number;
  suspendAfterIdleMin: number;
  reqNotUnlocked: boolean;
  freeSupercharging: boolean;
  lfpBattery: boolean;
  /** The owner's pick when the VIN offers several packs; null follows the VIN. */
  usableWhenNewKwh: number | null;
}

export type PreferredRange = "ideal" | "rated";

export interface DriveDto {
  id: number;
  carId: number;
  startAt: number;
  endAt: number | null;
  distanceKm: number | null;
  durationMin: number | null;
  speedMaxKmh: number | null;
  powerMaxKw: number | null;
  startKm: number | null;
  endKm: number | null;
  outsideTempAvg: number | null;
  insideTempAvg: number | null;
  startRangeKm: number | null;
  endRangeKm: number | null;
  startBatteryLevel: number | null;
  endBatteryLevel: number | null;
  energyUsedKwh: number | null;
  consumptionKwhPer100km: number | null;
  startLabel: string | null;
  endLabel: string | null;
  /**
   * The town each end sits in, kept apart from the label because the page dims it.
   * Null when the label is a geofence the owner named, or when the geocoder had
   * nothing finer to say than the town — which is then the label itself.
   */
  startRegion: string | null;
  endRegion: string | null;
  /**
   * What polling could not pin down (shared/uncertainty.ts). A span says the
   * start (or end) lies between two readings; null, that `startAt` (`endAt`) is
   * as observed. `durationRangeMin` is the shortest and longest the drive can
   * have taken, null when `durationMin` stands as measured.
   */
  startSpan: TimeSpan | null;
  endSpan: TimeSpan | null;
  durationRangeMin: NumberRange | null;
  /**
   * Nobody saw it: the odometer moved while the car could not be read. Both
   * ends span the whole gap, and it has no duration, route or consumption.
   */
  reconstructed: boolean;
  /** Its first position is where the car was parked, not a sample. */
  originReconstructed: boolean;
}

interface DrivePointDto {
  at: number;
  latitude: number | null;
  longitude: number | null;
  speedKmh: number | null;
  powerKw: number | null;
  batteryLevel: number | null;
  usableBatteryLevel: number | null;
  odometerKm: number | null;
  outsideTemp: number | null;
  insideTemp: number | null;
  elevation: number | null;
  rangeKm: number | null;
}

export interface DriveDetailDto extends DriveDto {
  positionCount: number;
  positions: DrivePointDto[];
  /**
   * Where each end of the drive actually is, plus whether it already fell inside
   * a geo-fence — what the "add a geo-fence here" links need: the true endpoint
   * positions, not the downsampled chart track, and an explicit "already named"
   * rather than guessing it off the label.
   */
  startLatitude: number | null;
  startLongitude: number | null;
  endLatitude: number | null;
  endLongitude: number | null;
  startGeofenceId: number | null;
  endGeofenceId: number | null;
}

/** Min/max of a numeric column, used to set range-slider extents. */
export interface Bound {
  min: number;
  max: number;
}

export interface DriveListDto {
  drives: DriveDto[];
  totals: {
    count: number;
    distanceKm: number | null;
    durationMin: number | null;
    energyKwh: number | null;
    consumptionKwhPer100km: number | null;
  };
  bounds: {
    distanceKm: Bound;
    durationMin: Bound;
    consumption: Bound;
  };
}

/** Combined route over the filtered drives, plus charging in the same window. */
export interface DrivesRouteDto {
  fromAt: number | null;
  toAt: number | null;
  path: { latitude: number; longitude: number }[];
  charging: {
    count: number;
    energyKwh: number | null;
    durationMin: number | null;
    costCents: number | null;
  };
  /**
   * Range of ground the route covered, read off the thinned track — so it is the
   * lowest and highest sample kept, not necessarily of every one taken.
   */
  minElevationM: number | null;
  maxElevationM: number | null;
}

export interface ChargeDto {
  id: number;
  carId: number;
  startAt: number;
  endAt: number | null;
  energyAddedKwh: number | null;
  energyUsedKwh: number | null;
  durationMin: number | null;
  startBatteryLevel: number | null;
  endBatteryLevel: number | null;
  startRangeKm: number | null;
  endRangeKm: number | null;
  rangeAddedKm: number | null;
  outsideTempAvg: number | null;
  costCents: number | null;
  costPerKwhCents: number | null;
  maxPowerKw: number | null;
  currentType: "ac" | "dc";
  chargerType: string | null;
  label: string | null;
  /** The town it sits in, dimmed after the label. See DriveDto. */
  region: string | null;
  /** See DriveDto. A reconstructed charge is a state-of-charge rise nobody saw. */
  startSpan: TimeSpan | null;
  endSpan: TimeSpan | null;
  durationRangeMin: NumberRange | null;
  reconstructed: boolean;
  /**
   * The top of the cost's range, when its inputs were bounded rather than
   * measured; `costCents` is then the bottom. Null: the cost is exactly
   * `costCents` (and 0 there means free, not unknown — unknown is null).
   */
  costMaxCents: number | null;
  /**
   * Where the cost came from: "tariff" the place's price (recomputed when it
   * changes), "manual" the owner's own figure (never touched), "legacy" a cost
   * recorded before tariffs that the current one does not reproduce (kept as
   * it was). Null with no cost.
   */
  costSource: CostSource | null;
}

export type CostSource = "tariff" | "manual" | "legacy";

/** What a tariff made of one stretch of the session at one rate. */
export interface CostPartDto {
  /** The window's label, or null for the base rate. */
  label: string | null;
  /** -1: the base rate; otherwise the window's index in its price. */
  window: number;
  rate: number;
  /** kWh or minutes billed at this rate, as a range when placement is bounded. */
  min: number;
  max: number;
}

/** How a cost was arrived at — the line under the charge's cost. */
export interface CostDetailDto {
  /** Free supercharging: nothing else applied. */
  free: boolean;
  /** The dated price used, by its first day. */
  priceFrom: string | null;
  billingType: "per_kwh" | "per_minute" | null;
  /** Grid-side kWh billed (per-kWh prices), as a range. */
  billedKwh: NumberRange | null;
  /** True when billed kWh is battery energy divided by `efficiency`, not a meter's. */
  estimated: boolean;
  efficiency: number | null;
  sessionFeeCents: number | null;
  parts: CostPartDto[];
}

export interface ChargeSampleDto {
  at: number;
  batteryLevel: number | null;
  usableBatteryLevel: number | null;
  energyAddedKwh: number;
  powerKw: number;
  voltage: number | null;
  current: number | null;
  rangeKm: number | null;
  outsideTemp: number | null;
  /** Coldest and warmest battery module, °C. Null unless the source measured the pack. */
  batteryTempMin: number | null;
  batteryTempMax: number | null;
}

export interface ChargeDetailDto extends ChargeDto {
  /** How a tariff priced it; null for a manual, legacy or missing cost. */
  costDetail: CostDetailDto | null;
  /** With a manual cost: the kWh the bill says, and the owner's note. */
  costBilledKwh: number | null;
  costNote: string | null;
  latitude: number | null;
  longitude: number | null;
  addressDisplayName: string | null;
  samples: ChargeSampleDto[];
}

export interface ChargeListDto {
  charges: ChargeDto[];
  totals: {
    count: number;
    energyAddedKwh: number | null;
    energyUsedKwh: number | null;
    durationMin: number | null;
    costCents: number | null;
    /** The total's top when some sessions' costs are ranges; null when it is exact. */
    costMaxCents: number | null;
    /**
     * How many of those sessions each sum actually has a figure for — the
     * denominators a per-session average may divide by, which are not always the
     * session count.
     *
     * Cost is the reason: it is null unless a tariff on the place, or free
     * supercharging, said what the session cost, so a rig that prices nothing has
     * a cost for none of them and one that prices home charging has a cost for
     * some. A mean over every session would read as "charging is nearly free"
     * where the truth is "most of it was never priced". Energy added is the same
     * shape for a smaller reason: a few cars report only the energy drawn.
     */
    energyAddedCount: number;
    costCount: number;
  };
  bounds: {
    energyKwh: Bound;
    durationMin: Bound;
    costCents: Bound;
  };
}

/**
 * One place the car has charged, with every session there rolled into it. A
 * place is a geofence, else an address, else the parking spot rounded to about
 * a hundred metres — so the same driveway is one point however it was logged.
 */
export interface ChargeMapPointDto {
  /** Stable identity of the place, for React keys and marker reuse. */
  key: string;
  label: string | null;
  latitude: number;
  longitude: number;
  count: number;
  energyKwh: number | null;
  costCents: number | null;
  lastAt: number;
}

export interface ChargeMapDto {
  points: ChargeMapPointDto[];
  /** Sessions the filter matched that carry no coordinates, so are not drawn. */
  unlocated: number;
  /** True when there were more places than the map returns. */
  truncated: boolean;
}

/**
 * One stretch of the week with its own price, in the place's local time.
 * `start`/`end` are "HH:MM". An `end` at or before `start` crosses midnight:
 * 22:00–06:00 on Monday runs from Monday night into Tuesday morning, and
 * 00:00–00:00 is the whole day. `days` and `months` say on which days the
 * window *starts* (ISO weekdays, 1 = Monday … 7 = Sunday; months 1–12, null or
 * empty for every month). Later windows win where they overlap.
 */
export interface TariffWindowDto {
  label: string | null;
  days: number[];
  start: string;
  end: string;
  months: number[] | null;
  /** Price per kWh or per minute, as the price's billing type says, in major units. */
  rate: number;
}

/**
 * A price that applies from a local day on, until the next one starts. Base
 * rate everywhere no window covers.
 */
export interface TariffPriceDto {
  /** "YYYY-MM-DD", the first local day (in the place's time zone) it applies on. */
  validFrom: string;
  billingType: "per_kwh" | "per_minute";
  /** Per kWh or per minute, in major units. */
  rate: number;
  sessionFeeCents: number | null;
  windows: TariffWindowDto[];
}

export interface GeofenceDto {
  id: number;
  name: string;
  latitude: number;
  longitude: number;
  radius: number;
  /** IANA zone the tariff's days and hours are read in; null: the account's. */
  timezone: string | null;
  /** The charger's power here, kW, which caps how much energy any hour can take. Null: unknown. */
  chargerPowerKw: number | null;
  /** Share of the grid's energy that reaches the battery, 0–1. Null: the defaults (88% AC, 95% DC). */
  acEfficiency: number | null;
  dcEfficiency: number | null;
  /** Dated prices, oldest first. Empty: sessions here are not priced. */
  tariff: TariffPriceDto[];
  /** The first charging session at this place, if any. */
  firstChargeAt: number | null;
  /** Its local day, "YYYY-MM-DD" — what "start the tariff on the first charge" sets. */
  firstChargeDate: string | null;
  /** Sessions here before the tariff's first day, which stay unpriced. */
  chargesBeforeTariff: number;
  /** Sessions here still waiting to be repriced after a change; the cron finishes them. */
  repricing: number;
}

export type Period = "day" | "week" | "month" | "year";

interface PeriodBucketDto {
  key: string;
  label: string;
  from: number;
  driveCount: number;
  distanceKm: number | null;
  durationMin: number | null;
  energyUsedKwh: number | null;
  consumptionKwhPer100km: number | null;
  chargeCount: number;
  energyChargedKwh: number | null;
  costCents: number | null;
  costPerKwhCents: number | null;
  costPer100kmCents: number | null;
}

export interface PeriodStatsDto {
  period: Period;
  timezone: string;
  buckets: PeriodBucketDto[];
}

export interface ChargingSideDto {
  count: number;
  energyKwh: number | null;
  costCents: number | null;
  durationMin: number | null;
}

export interface ChargingLocationDto {
  label: string;
  count: number;
  energyKwh: number | null;
  costCents: number | null;
}

export interface ChargingStatsDto {
  ac: ChargingSideDto;
  dc: ChargingSideDto;
  topLocations: ChargingLocationDto[];
  /** The same roll-up ordered by spend, which is rarely the same ten places. */
  topByCost: ChargingLocationDto[];
  startSocBands: { band: number; count: number; energyKwh: number | null }[];
  totalCostCents: number | null;
  /** Of that total, what went to Superchargers. */
  superchargerCostCents: number | null;
  /** Distance driven in the same window, so cost can be put against it. */
  distanceKm: number | null;
  /** The figure that compares against a petrol car. */
  costPer100kmCents: number | null;
  /** Sessions started per local weekday (1 = Monday … 7 = Sunday) and hour. */
  heatmap: { weekday: number; hour: number; count: number; energyKwh: number | null }[];
  /**
   * Average DC power at each 10% band of the pack, across every DC session in the
   * window — the shape of a Supercharger taper, averaged out of the noise of any
   * single session.
   */
  dcCurve: { band: number; avgPowerKw: number | null; samples: number }[];
}

export interface BatteryHealthDto {
  points: { at: number; odometerKm: number | null; capacityKwh: number; rangeAt100Km: number | null }[];
  currentCapacityKwh: number | null;
  /** The first sessions on record — a floor for degradation, not the pack when new. */
  originalCapacityKwh: number | null;
  degradationPercent: number | null;
  /** What the VIN says the pack held when new (approximate, usable). */
  newCapacityKwh: number | null;
  /** Loss measured against `newCapacityKwh` — the true since-new figure. */
  degradationFromNewPercent: number | null;
  currentRangeAt100Km: number | null;
}

export interface VampireDrainDto {
  periods: {
    fromAt: number;
    toAt: number;
    hours: number;
    rangeLostKm: number;
    rangeLostPerHourKm: number | null;
    socLost: number | null;
    latitude: number | null;
    longitude: number | null;
  }[];
  averageLossPerHourKm: number | null;
}

export interface UpdateDto {
  id: number;
  carId: number;
  startAt: number;
  endAt: number;
  version: string | null;
  daysSincePrevious: number | null;
}

/** driving | charging | updating | online | asleep | offline | unknown */
export type TimelineState = "driving" | "charging" | "updating" | "online" | "asleep" | "offline" | "unknown";

/** What the car was doing over a window, as one gapless band of spans. */
export interface StateTimelineDto {
  from: number;
  to: number;
  spans: { state: TimelineState; from: number; to: number }[];
  /** Fraction of the window in each state, largest first. */
  totals: { state: TimelineState; ms: number; share: number }[];
  /** The state the car is in now, and since when. Null when nothing is logged. */
  current: { state: TimelineState; since: number } | null;
}

/** State of charge over a window, averaged into fixed buckets. */
export interface ChargeLevelDto {
  from: number;
  to: number;
  /** Width of one bucket in milliseconds. */
  bucketMs: number;
  points: { at: number; batteryLevel: number | null; usableBatteryLevel: number | null }[];
  minLevel: number | null;
  maxLevel: number | null;
  averageLevel: number | null;
  /** Share of sampled buckets at or above `highSocThreshold`, 0..1. */
  highSocShare: number | null;
  highSocThreshold: number;
}

/**
 * Consumption against outside temperature — the panel that explains winter range
 * loss, which is the thing most often mistaken for degradation.
 */
export interface EfficiencyStatsDto {
  from: number;
  to: number;
  distanceKm: number | null;
  /** What the drives took out of the pack, per 100 km. */
  netKwhPer100km: number | null;
  /**
   * What the wall delivered per 100 km, so charging losses are inside it. Charges
   * and drives in one window do not correspond one-to-one — you can charge more than
   * you drove — so this only means anything over a window long enough for the two to
   * even out. A year does; a day does not.
   */
  grossKwhPer100km: number | null;
  /** Share of wall energy that never reached the pack, 0..1. */
  chargingLossShare: number | null;
  /** Consumption per 5 °C band of average outside temperature during the drive. */
  bands: {
    fromCelsius: number;
    drives: number;
    distanceKm: number | null;
    consumptionKwhPer100km: number | null;
  }[];
}

/** The odometer as a series — the visual companion to extrapolated mileage. */
export interface OdometerSeriesDto {
  from: number;
  to: number;
  /** Width of one bucket in milliseconds. */
  bucketMs: number;
  points: { at: number; odometerKm: number | null }[];
}

/**
 * What a place most likely is, read off the OSM tags the reverse geocoder already
 * returned. Only kinds an OSM object states about itself — a `school` is a school —
 * plus `home`, the one guess made from visiting patterns instead of tags.
 */
export type PlaceCategory =
  | "home"
  | "office"
  | "school"
  | "university"
  | "kindergarten"
  | "gym"
  | "supermarket"
  | "shopping"
  | "restaurant"
  | "cafe"
  | "hospital"
  | "charging"
  | "hotel";

/**
 * What the reverse geocoder has learned: how much of the world the car has been to,
 * and which parts of it repeatedly. Counted over drive arrivals, so "visits" means
 * times the car parked there, not times it passed through.
 */
export interface PlaceStatsDto {
  counts: { addresses: number; cities: number; states: number; countries: number };
  topCities: {
    label: string;
    visits: number;
    lastAt: number | null;
    /** Names of the geo-fences the car has arrived inside within this city. */
    geofences: string[];
  }[];
  topCountries: { label: string; visits: number; lastAt: number | null }[];
  /**
   * Most recently arrived at first — where the car has actually been lately.
   * Carries the spot itself so an unnamed row can become a geo-fence directly,
   * exactly as a `topPlaces` row can.
   */
  recent: {
    label: string;
    /** The OSM object's own name, when it has one — the better prefill for a new geo-fence. */
    name: string | null;
    city: string | null;
    visits: number;
    lastAt: number;
    latitude: number | null;
    longitude: number | null;
    geofence: string | null;
  }[];
  /**
   * The addresses the car keeps coming back to, most-visited first — the natural
   * candidates for the next geo-fence. `geofence` is set when arrivals there already
   * match one; `category` only when the OSM tags (or, for home, the sheer share of
   * arrivals) leave little doubt what the place is.
   */
  topPlaces: {
    label: string;
    /** The OSM object's own name ("Lidl", "Humboldt-Universität"), when it has one. */
    name: string | null;
    city: string | null;
    visits: number;
    lastAt: number;
    latitude: number | null;
    longitude: number | null;
    geofence: string | null;
    category: PlaceCategory | null;
  }[];
}

/**
 * Aggregates over the drives in a window: the typical drive, the rate the car is
 * being used at, and where it keeps going.
 */
export interface DriveStatsDto {
  from: number;
  to: number;
  count: number;
  distanceKm: number | null;
  /** The middle drive, which is a fairer "typical drive" than the mean. */
  medianDistanceKm: number | null;
  maxSpeedKmh: number | null;
  /**
   * Per-day rates and the extrapolations from them, measured over the span the data
   * actually covers rather than the window asked for — a year-long window holding
   * ten weeks of history would otherwise divide by 365 and report a fifth of the
   * real rate. Null until there are two days to average over.
   */
  observedDays: number | null;
  distancePerDayKm: number | null;
  energyPerDayKwh: number | null;
  projectedMonthlyKm: number | null;
  projectedAnnualKm: number | null;
  /**
   * Position samples per 20 km/h band. Sample counts, not time: the logger polls
   * at a roughly steady rate, so the shape is right, but a band's share is only
   * approximately the share of time spent in it.
   */
  speedBands: { fromKmh: number; count: number }[];
  /** Where drives ended most often. The on-ramp to naming a place. */
  topDestinations: { label: string; region: string | null; count: number; distanceKm: number | null }[];
}

/**
 * Somewhere the car was parked part-way through a journey, and what happened
 * there. A stop is the gap between two of the trip's drives, so a trip of five
 * drives has four of them — arriving at the end is the trip ending, not a stop in
 * it. The exception is a trip still under way, whose last stop is where the car is
 * sitting now and has no leaving time yet.
 */
export interface TripStopDto {
  label: string | null;
  /** The town it sits in, dimmed after the label. See DriveDto. */
  region: string | null;
  arrivedAt: number;
  /** Null only for the current stop of a trip still under way. */
  leftAt: number | null;
  stayedMin: number | null;
  /** The pack on arrival — the end level of the drive that reached the stop. */
  batteryLevel: number | null;
  chargeCount: number;
  energyKwh: number | null;
  costCents: number | null;
}

/**
 * One drive of a trip, reduced to what the itinerary needs to say between two
 * stops: when it left, when it arrived, and what the leg took. The full drive
 * rows stay on the Drives page; repeating them here would say nothing new.
 */
export interface TripLegDto {
  startAt: number;
  endAt: number;
  distanceKm: number | null;
  durationMin: number | null;
}

/**
 * One journey: the drives that belong together, what was spent getting there and
 * back, and where it stopped on the way.
 *
 * Charging is counted only at the stops inside the trip, so a closed trip's cost is
 * what the journey cost — not what was put back into the car at home afterwards.
 */
export interface TripDto {
  /** The first drive's start, which is what identifies the trip in a URL. */
  startAt: number;
  /** The last drive's end. For a trip under way, that is where it has got to. */
  endAt: number;
  /** True while the car is still out, or has not been home long enough to say. */
  open: boolean;
  /**
   * True when the journey reaches the edge of what was read, so it may have more
   * drives outside it. Only a trip longer than a fortnight can do this, and it is
   * said out loud rather than presented as a whole journey with a wrong beginning.
   */
  truncated: boolean;
  startLabel: string | null;
  endLabel: string | null;
  /** The towns those two sit in, dimmed after them. See DriveDto. */
  startRegion: string | null;
  endRegion: string | null;
  /** Where it stayed longest, which is what a person would call the trip. */
  destinationLabel: string | null;
  destinationRegion: string | null;
  driveCount: number;
  distanceKm: number | null;
  drivingMin: number | null;
  energyKwh: number | null;
  consumptionKwhPer100km: number | null;
  chargeCount: number;
  chargedKwh: number | null;
  costCents: number | null;
  startBatteryLevel: number | null;
  endBatteryLevel: number | null;
  /** The lowest the pack got, which is the nerve of a long drive. */
  minBatteryLevel: number | null;
  stops: TripStopDto[];
  /**
   * One per drive, in order. Interleaved with `stops` they are the itinerary:
   * leg, stop, leg, stop… — a closed trip's last leg arrives at `endLabel`, an
   * open trip's at the stop the car is sitting at now.
   */
  legs: TripLegDto[];
}

/**
 * The journeys in a window, plus what it took to decide they were journeys —
 * shown on the page, because a list produced by a heuristic that will not say what
 * it is doing cannot be argued with.
 */
export interface TripsDto {
  from: number;
  to: number;
  trips: TripDto[];
  /**
   * Distance in the window that was on a trip, and distance that was not — the
   * everyday driving. Both count only drives that *started* inside the window, so
   * they are two halves of one total and a share of one is a share of the other. A
   * trip's own `distanceKm` is the whole journey and can therefore be larger than
   * its contribution here, when the window opens part-way through it.
   */
  tripDistanceKm: number | null;
  otherDistanceKm: number | null;
  criteria: {
    minDistanceKm: number;
    minDrives: number;
    returnStopHours: number;
    longStopHours: number;
  };
}

/** drive | charge | sleep | offline | update */
export type TimelineEventKind = "drive" | "charge" | "sleep" | "offline" | "update";

/**
 * One thing that happened, flattened out of whichever table recorded it. Only the
 * fields the kind actually has are populated — a sleep span has no distance, an
 * update has no place — so a reader has to switch on `kind` before trusting a null.
 *
 * Events still in progress are included, with a null `endAt`. They are the newest
 * thing that happened and the reason to look at a log at all.
 */
export interface TimelineEventDto {
  kind: TimelineEventKind;
  /** Row id in the source table — what the drive and charge links are built from. */
  id: number;
  carId: number;
  startAt: number;
  endAt: number | null;
  durationMin: number | null;
  /** Where it happened, or the firmware version for an update. */
  label: string | null;
  /** Where a drive ended. Null for every other kind. */
  endLabel: string | null;
  /** The towns those sit in, dimmed after them. See DriveDto. */
  region: string | null;
  endRegion: string | null;
  distanceKm: number | null;
  energyKwh: number | null;
  costCents: number | null;
  /** See ChargeDto. */
  costMaxCents: number | null;
  startBatteryLevel: number | null;
  endBatteryLevel: number | null;
  /** See DriveDto. Only drives and charges carry these. */
  startSpan: TimeSpan | null;
  endSpan: TimeSpan | null;
  reconstructed: boolean;
}

/** A page of the event log, newest first. */
export interface TimelineDto {
  events: TimelineEventDto[];
  /** Opaque cursor for the page after this one; null once the window is exhausted. */
  nextCursor: string | null;
}

/**
 * A session the logger opened and never closed. Either something newer started in
 * the same table — so this one was left behind — or it has been open too long to
 * still be happening. A sleep span is exempt from the second test: a car can
 * legitimately be asleep for a fortnight.
 */
export interface TruncatedSessionDto {
  /** Which table it came from, in the words the rest of the app uses. */
  kind: "drive" | "charge" | "state" | "update";
  id: number;
  carId: number;
  startAt: number;
  /** Where a drive or charge was, the state name, or the firmware version. */
  label: string | null;
  /** True when nothing newer exists in its table, i.e. it is the last thing logged. */
  last: boolean;
}

/**
 * What the database has to say about itself: how much is in it, when it last heard
 * from the car, and whether anything looks half-written. Low glamour, and the
 * cheapest answer to "did my import actually land".
 */
export interface DataHealthDto {
  /** Every table the CSV export offers, with what is in it. */
  tables: { table: string; rows: number }[];
  /** Newest position sample, which is when the logger last heard anything. */
  lastSampleAt: number | null;
  /** Sessions that look half-written, newest first. */
  truncated: TruncatedSessionDto[];
  /** How many there are in total, when the list above is capped. */
  truncatedCount: number;
}

/** One import of a history exported from another logging service. */
export interface ImportJobDto {
  id: string;
  /** The uploaded file's name. */
  label: string;
  /** Adapter id, e.g. "tessie". */
  source: string;
  vin: string | null;
  carId: number | null;
  phase: "uploading" | "importing" | "done" | "failed" | "cancelled";
  startedAt: number;
  finishedAt: number | null;
  /** 0..1 through the export's period; null until the period is known. */
  progress: number | null;
  /** Sample time the import has reached — the date the user sees ticking up. */
  at: number | null;
  firstAt: number | null;
  lastAt: number | null;
  counts: {
    samples: number;
    positions: number;
    drives: number;
    drivesDiscarded: number;
    chargingProcesses: number;
    charges: number;
    states: number;
  };
  distanceKm: number;
  energyAddedKwh: number;
  /** Pre-existing rows dropped because the import covered the same period. */
  replacedRows: number;
  /**
   * Events a direct import (TeslaMate) left out: overlapping what EVBook had
   * already logged for the car, or never finished at the source. Null for a
   * replayed import.
   */
  skipped: { overlapping: number; unfinished: number } | null;
  /** What a direct import is working on, in words; null otherwise. */
  stage: string | null;
  /**
   * True when this import stopped part-way and can carry on from where it got to
   * — the upload and the cursor are both still held.
   */
  resumable: boolean;
  /**
   * When the kept upload will be thrown away if nobody resumes. Null when there is
   * nothing being held.
   */
  uploadExpiresAt: number | null;
  /** What the adapter had to work around. */
  warnings: string[];
  error: string | null;
}

export interface ImportSourceDto {
  id: string;
  label: string;
  describe: string;
  howToExport: string | null;
  /** File-picker hint, e.g. ".zip". */
  accept: string | null;
}

/** One finished or partial direct import of one car, as the history list shows it. */
export interface ImportRecordDto {
  id: number;
  carId: number;
  carName: string | null;
  vin: string;
  source: string;
  label: string | null;
  status: "importing" | "done" | "deleting";
  /** EVBook's first reading of the car; history from before it was taken. */
  cutoffAt: number | null;
  firstAt: number | null;
  lastAt: number | null;
  drives: number;
  chargingProcesses: number;
  positions: number;
  skippedOverlapping: number;
  skippedUnfinished: number;
  createdAt: number;
}

/** Which drawer of the glovebox a document is filed in. */
export type DocumentCategory = "title" | "inspection" | "tax" | "insurance";

/** One uploaded document — the bytes live behind /documents/:id/file. */
export interface DocumentDto {
  id: string;
  /** The car whose paperwork this is — every document belongs to one car. */
  carId: number;
  category: DocumentCategory;
  /** Display name, taken from the uploaded file's name. */
  name: string;
  contentType: string;
  sizeBytes: number;
  createdAt: number;
  /** Whether a preview exists behind /documents/:id/thumbnail — PDFs and pre-thumbnail uploads have none. */
  hasThumbnail: boolean;
}
