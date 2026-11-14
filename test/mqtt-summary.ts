import type { CarSummaryDto } from "@shared/api-types";

/**
 * A summary with every field set, optional ones included, so the MQTT tests
 * see each topic the publisher can send. `Required<…>` makes a new summary
 * field a type error here until it is added, and with it to docs/mqtt.md.
 */
export const FULL_SUMMARY: Required<CarSummaryDto> = {
  carId: 1,
  state: "charging",
  since: Date.UTC(2026, 10, 14, 17, 2),
  healthy: true,

  batteryLevel: 57,
  usableBatteryLevel: 56,
  chargeLimitSoc: 80,
  idealBatteryRangeKm: 340.2,
  ratedBatteryRangeKm: 327.4,
  estBatteryRangeKm: 290.1,

  odometerKm: 118199.3,
  speedKmh: null,
  power: 11,
  shiftState: "P",
  latitude: 47.1,
  longitude: 8.5,
  heading: 182,

  insideTemp: 19.5,
  outsideTemp: 6,
  driverTempSetting: 21,
  isClimateOn: false,
  isPreconditioning: false,

  locked: true,
  sentryMode: false,
  isUserPresent: false,
  doorsOpen: false,
  trunkOpen: false,
  windowsOpen: false,

  chargingState: "Charging",
  chargerPower: 11,
  chargerVoltage: 230,
  chargerCurrent: 16,
  chargerPhases: 3,
  chargeEnergyAdded: 7.42,
  timeToFullCharge: 1.5,
  chargePortDoorOpen: true,

  version: "2026.38.4",
  updateAvailable: false,
  updateVersion: null,

  tpmsPressureFl: 2.9,
  tpmsPressureFr: 2.9,
  tpmsPressureRl: 2.875,
  tpmsPressureRr: 2.9,
  tpmsSoftWarningFl: false,
  tpmsSoftWarningFr: false,
  tpmsSoftWarningRl: false,
  tpmsSoftWarningRr: false,
  tyres: [],
  maintenance: null,

  dataAt: Date.UTC(2026, 10, 14, 18, 30),

  doorDfOpen: false,
  doorPfOpen: false,
  doorDrOpen: false,
  doorPrOpen: false,
  windowFdOpen: false,
  windowFpOpen: false,
  windowRdOpen: false,
  windowRpOpen: false,

  chargeRateKmh: 70,
  connChargeCable: "IEC",
  batteryHeater: false,
  cabinOverheatProtection: "Off",
  copActivelyCooling: false,
  passengerTempSetting: 21,
  autoSeatClimateLeft: false,
  autoSeatClimateRight: false,
  autoSteeringWheelHeat: false,
  dashcamState: "Unavailable",
  scheduledChargingPending: false,
  tripCharging: false,

  activeRoute: null,
  sleepBlocker: null,
  lastFetchAt: Date.UTC(2026, 10, 14, 18, 30, 12),
  lastError: null,
  provider: "tesla",
};
