# See how a road trip went

**Category** Driving
**Persona** Owner back from a day out who wants the whole journey in one place
**Spec** [`trips.spec.ts`](trips.spec.ts)

## Why it matters

A road trip is one thing to a person and several rows to a logger. Everywhere else
in the app it is a drive, then a charge, then another drive, each with its own row
and its own totals — and the question people actually ask is "how did the trip go",
which none of those rows answers on its own.

This is also the page that has to explain itself. The grouping is a heuristic, so
it says on the page what it counted as a journey; a list that will not tell you its
own rule cannot be argued with when a trip is missing from it.

## Preconditions

- The seeded world holds one journey: Berlin to Leipzig and back, with a DC fast
  charge in Leipzig in between. The Sunday trips to the lake are 55 km round and so
  are everyday driving, not journeys — which is the threshold doing its job.

## Steps

| # | Step | Expected |
|---|------|----------|
| 1 | Open Trips | The journey is listed; the criteria are stated |
| 2 | Read the summary figures | Trips, distance, share of all driving, spend |
| 3 | Open the journey | Route map, the states over the trip, and the stops |
| 4 | Read the stop | Leipzig, how long the car was there, what it charged |
| 5 | Close it again | Back to the list, and the URL forgets the selection |

## Screens

`screens/desktop`, `screens/mobile` — one numbered PNG per step above.
`video/` — the whole flow as a screencast.
