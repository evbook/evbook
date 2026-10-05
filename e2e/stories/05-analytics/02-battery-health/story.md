# Check whether the battery is degrading — or whether it was just cold

**Category** Analytics
**Persona** Owner deciding whether the pack is holding up
**Spec** [`health.spec.ts`](health.spec.ts)

## Why it matters

Battery anxiety is why people install a logger in the first place. Capacity is
derived from charging sessions that filled at least 10% of the pack, so the
seeded world fades the pack slightly every day to make the trend real.

Most range complaints are not degradation, though. Range that drops every winter and
comes back every spring is the weather, and the consumption-by-temperature panel is
what tells the two apart — on the same page as the degradation figure it keeps getting
confused with. It also carries the only net-versus-gross figures in the app: what the
driving took out of the pack, against what the wall had to put back, with the
difference named as charging loss.

## Preconditions

- Ten weeks of seeded charging, with the pack fading from 75.0 kWh.
- Idle stretches between drives, so vampire drain can be measured.

## Steps

| # | Step | Expected |
|---|------|----------|
| 1 | Open Health | Usable capacity, degradation, range at 100% and idle loss are filled in |
| 2 | Look at capacity over time | A downward trend across the history |
| 3 | Switch the capacity chart to mileage | The same fade against the odometer |
| 4 | Look at range vs temperature | Net and gross consumption, the charging loss between them, and a line across the 5 °C bands |
| 5 | Look at mileage over time | The odometer as a line, with stretches that logged nothing left as gaps |
| 6 | Look at idle loss and software updates | Both list the seeded stretches and versions |

## Screens

`screens/desktop`, `screens/mobile` — one numbered PNG per step above.
`video/` — the whole flow as a screencast.
