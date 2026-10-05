# Name a place and price its electricity

**Category** Places
**Persona** Owner who charges at a friend's house and wants it labelled and costed
**Spec** [`places.spec.ts`](places.spec.ts)

## Why it matters

Geo-fences are what turn coordinates into "Home" and "Office" throughout the
app, and they are how charging gets priced automatically. This story covers the
full write path: create, edit, and delete.

Underneath them is the address roll-up, which is the same page's answer to "which
places deserve a geo-fence at all". Reverse geocoding is already being paid for on
every drive, with a throttle and a distance-based cache, and until now the result was
only ever a string on a drive row. Counted by arrivals, it says plainly that the car
has parked on one street sixty-six times — which is the argument for naming it.

## Preconditions

- Four seeded geo-fences: Home, Office, and two superchargers.

## Steps

| # | Step | Expected |
|---|------|----------|
| 1 | Open Places | The seeded fences are listed with their radius and cost |
| 2 | Start a new place | The form opens with a draggable pin and a radius circle |
| 3 | Fill in name, radius and a per-kWh rate, then save | The new place appears in the list with its cost |
| 4 | Edit the rate | The list shows the new rate |
| 5 | Delete it | The list is back to the seeded four |
| 6 | Look at everywhere the car has been | Counts of addresses, cities, regions and countries, the most-visited cities by arrivals, and the last twenty places it parked |

## Screens

`screens/desktop`, `screens/mobile` — one numbered PNG per step above.
`video/` — the whole flow as a screencast.
