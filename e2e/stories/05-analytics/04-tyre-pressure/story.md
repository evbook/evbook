# Notice a slow leak before it becomes a flat

**Category** Analytics
**Persona** Owner who would rather hear about a tyre from the logbook than from the hard shoulder

**Spec** [`tyres.spec.ts`](tyres.spec.ts)

## Why it matters

A slow leak takes weeks, and the car's own TPMS warning only comes on once the
tyre is already a quarter down. EVBook reads the four pressures from the
snapshots it fetches anyway — never waking the car for them — and keeps them as
a history next to what the car recommends for each axle. The Health entry in the
navigation carries a dot from every page while a tyre needs attention, so the
owner does not have to go looking.

A tyre the car did not report is shown as not reported, never as fine.

## Preconditions

- The seeded car's rear left tyre has been losing air for two and a half weeks
  and reads 2.4 bar against the 2.9 bar the car recommends; the car has raised
  its soft warning for it (`e2e/mocks/world.mjs`, `e2e/mocks/tyres.mjs`).
- The other three tyres sit within a few hundredths of the recommendation.

## Steps

| # | Step | Expected |
|---|------|----------|
| 1 | Open Drives | The Insights entry in the navigation carries an amber dot |
| 2 | Open the Insights menu | Health carries the dot, named for a screen reader as a tyre needing attention |
| 3 | Open Health and look at the tyre tile | Four wheels laid out as on the car; rear left reads 2.40 bar against 2.90 recommended, marked Low; the rest OK |
| 4 | Read how the status is decided | The car's warnings first, then 10 % under / 25 % under / 20 % over the recommendation |
| 5 | Look at pressures over time | Opened already, because a tyre warns: a front and a rear axle chart, left and right lines and the recommendation dashed; the rear left slopes down |
| 6 | Switch to 12 months | The same charts over the year, by week |
| 7 | Collapse the history | Only its title remains |

## Screens

`screens/desktop`, `screens/mobile` — one numbered PNG per step above.
`video/` — the whole flow as a screencast.
