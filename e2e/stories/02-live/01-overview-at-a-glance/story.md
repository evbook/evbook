# Check on the car at a glance

**Category** Live
**Persona** Owner glancing at the app before leaving the house
**Spec** [`overview.spec.ts`](overview.spec.ts)

## Why it matters

The overview is the page people open ten times a day. It has to answer "where is
it, how full is it, what is it doing" without a click, and it has to keep up when
the car starts moving.

## Preconditions

- The car is parked at Home with a seeded charge level.
- The mock car can be switched between parked, driving and charging.

## Steps

| # | Step | Expected |
|---|------|----------|
| 1 | Open the overview | Car name, state, battery percentage, range and the map are visible, and the firmware version links to that release's notes on notateslaapp |
| 2 | Read the last 24 hours | A state band under the card: asleep, awake, driving, charging |
| 3 | Put the car on a charger | The card switches to Charging, with volts, amps and phases |
| 4 | Send the car driving | The card switches to Driving and shows a speed |
| 5 | Park it again | The card settles back to a parked state |

## Screens

`screens/desktop`, `screens/mobile` — one numbered PNG per step above.
`video/` — the whole flow as a screencast.
