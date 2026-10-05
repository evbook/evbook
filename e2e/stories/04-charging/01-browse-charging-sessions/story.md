# Review charging sessions and what they cost

**Category** Charging
**Persona** Owner checking how much of the month's charging was expensive DC
**Spec** [`charges.spec.ts`](charges.spec.ts)

## Why it matters

Charging is where the running costs are. The list has to separate cheap AC at
home from expensive DC on the road, the map has to show where the charging
actually happens, and the totals have to track whatever filter is applied.

## Preconditions

- Seeded history: ~34 sessions, of which two are DC fast charges (Leipzig and
  Tempelhof superchargers) priced per kWh by their geo-fences.

## Steps

| # | Step | Expected |
|---|------|----------|
| 1 | Open Charges | Sessions newest first, with energy and cost totals |
| 2 | Look at the map | One bubble per place, each counting the sessions charged there |
| 3 | Filter to DC only | Only the fast charges remain, totals shrink |
| 4 | Sort by energy added | The biggest session is on top |
| 5 | Back to AC and DC | The full list returns |

## Screens

`screens/desktop`, `screens/mobile` — one numbered PNG per step above.
`video/` — the whole flow as a screencast.
