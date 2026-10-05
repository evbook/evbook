# Find a particular drive in the history

**Category** Driving
**Persona** Owner reconstructing a trip for an expense claim
**Spec** [`drives.spec.ts`](drives.spec.ts)

## Why it matters

Ten weeks of commuting is a lot of rows. The list is only useful if the date
presets, the location search, the sliders and the sortable columns can cut it
down to the one drive somebody is looking for — and if the totals above the table
follow the selection.

## Preconditions

- Seeded history: ~130 drives, including one 186 km road trip to Leipzig.

## Steps

| # | Step | Expected |
|---|------|----------|
| 1 | Open Drives | The table lists drives newest first, with totals above it |
| 2 | Narrow to the last 30 days | Totals and rows shrink to that window |
| 3 | Search for "Leipzig" | Only the road-trip legs remain |
| 4 | Sort by distance, longest first | The 186 km leg is the top row |
| 5 | Open the combined route and charging panel | The map draws the selection and the charging summary adds up |
| 6 | Clear the filters | The full history is back |

## Screens

`screens/desktop`, `screens/mobile` — one numbered PNG per step above.
`video/` — the whole flow as a screencast.
