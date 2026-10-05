# See what driving costs per month, and the rate the car is being used at

**Category** Analytics
**Persona** Owner budgeting the car, and checking they will not run past a lease
mileage limit
**Spec** [`statistics.spec.ts`](statistics.spec.ts)

## Why it matters

This is the page that answers "what does this car actually cost me". It groups
everything by day, week, month or year in the configured time zone, and splits
charging into AC and DC.

The charging figures beneath it are the payoff for per-session cost editing and
geofence pricing: cost per 100 km is the number that compares against a petrol car,
and the AC-versus-DC rate per kWh is what says whether charging at home is actually
paying off. The heatmap and the averaged DC taper are the two shapes those numbers
have, rather than more numbers.

The drive aggregates answer a different question with the same data: not what has
happened, but the rate it is happening at. Extrapolated annual mileage is the figure
lease-limit and warranty owners check constantly, and the typical drive is a median
rather than a mean, so one airport run does not move it. Where drives end is the
natural on-ramp to naming a place: a destination visited forty times deserves a
geofence and a tariff, which is what makes the cost figures above it accurate.

## Preconditions

- Ten weeks of seeded history, so month grouping has more than one bucket.

## Steps

| # | Step | Expected |
|---|------|----------|
| 1 | Open Statistics | Totals for distance, time, energy and cost, plus the two charts |
| 2 | Group by week | The buckets get finer, the totals stay the same |
| 3 | Group by month | Back to coarse buckets |
| 4 | Look at how the car gets driven | Median drive, distance per day, extrapolated annual mileage and the fastest drive, with the span the rates were measured over named |
| 5 | Look at time at speed and where drives end | A histogram of speed bands, and the destinations ranked by how often drives ended there |
| 6 | Look at what the electricity costs | Cost per 100 km, the AC and DC rates per kWh, and the Supercharger share of the spend |
| 7 | Look at AC vs DC and the top locations | Both are filled in from the seeded sessions |
| 8 | Look at when charging happens and the DC taper | A full seven-day heatmap with real counts in it, and the averaged fast-charge curve |
| 9 | Look at where the money goes | The same places ranked by spend, with a per-kWh rate beside each |

## Screens

`screens/desktop`, `screens/mobile` — one numbered PNG per step above.
`video/` — the whole flow as a screencast.
