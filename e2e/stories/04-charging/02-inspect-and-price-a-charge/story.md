# Inspect a fast charge and correct its price

**Category** Charging
**Persona** Owner who paid a different price than the geo-fence assumes
**Spec** [`charge-detail.spec.ts`](charge-detail.spec.ts)

## Why it matters

The charging curve is the most interesting chart in the app — one telemetry
chart the owner composes from power, battery, energy, range, voltage, current
and pack temperature, over time or over state of charge, remembered from
session to session. This story also covers the one write on the page:
overriding the cost of a session.

## Preconditions

- The Leipzig DC session: 32% → 78%, ~34 kWh, peaking above 150 kW.

## Steps

| # | Step | Expected |
|---|------|----------|
| 1 | Open the DC session from the list | Header names the location; tiles show energy, duration, cost, and the max/peak extremes |
| 2 | Look at the telemetry chart | Power and battery are on, each with its own colored axis |
| 3 | Switch the x-axis to battery % | The battery chip sits out and the power line reads as the DC taper |
| 4 | Switch voltage and current on | Three lines share the panel; the axes give way to full-height scales |
| 5 | Override the total cost | The Cost tile repeats the figure, priced beside the map |

## Screens

`screens/desktop`, `screens/mobile` — one numbered PNG per step above.
`video/` — the whole flow as a screencast.
