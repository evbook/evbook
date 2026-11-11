# Put home charging on an off-peak tariff

**Category** Places
**Persona** Owner whose electricity is cheaper at night, and who wants each charge priced by when it happened
**Spec** [`tariff.spec.ts`](tariff.spec.ts)

## Why it matters

A flat price per place is wrong for most home charging: households on a
two-rate tariff pay one price by day and another at night, and the whole point
of charging at 22:00 is the night rate. A place's price is therefore a list of
dated prices, each with time windows that have their own rate.

The other half is honesty. A session nobody saw — the car was offline while it
charged — happened somewhere in a gap that spans both rates, so its cost is a
range: the cheapest and dearest bill the evidence allows. The charge page says
what it billed and at which rates in one line.

## Preconditions

- The seeded Home place with a flat per-kWh price.
- The seeded half-blind evening five days ago: a charge at home nobody saw,
  somewhere between about 21:35 and the early morning.

## Steps

| # | Step | Expected |
|---|------|----------|
| 1 | Open Home's place form | Its single price, from the start of the history |
| 2 | "New price from…" a week ago, add a 22:00–06:00 off-peak window at 0.12 | The new price is a copy of the old with the window, and the week preview shows the nights in the window's colour |
| 3 | Save | The list shows the price with its time window |
| 4 | Open the charge nobody saw | Its cost is a range, and the line under the tiles names the off-peak window and the estimated efficiency |
| 5 | Remove the new price again and save | Home is back on its flat price, as the other stories expect |

## Screens

`screens/desktop`, `screens/mobile` — one numbered PNG per step above.
`video/` — the whole flow as a screencast.
