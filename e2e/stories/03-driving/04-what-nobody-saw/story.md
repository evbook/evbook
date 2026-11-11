# See what happened while nobody was watching

**Category** Driving
**Persona** Owner whose logger was offline for an afternoon and a night
**Spec** [`what-nobody-saw.spec.ts`](what-nobody-saw.spec.ts)

## Why it matters

A poller only ever sees readings, never transitions. When the car is woken and
driven off before the first sample, the drive's start is known only to lie
between two readings; when the car could not be read at all (asleep, offline, a
lapsed token, the server down), a whole drive or charge can happen unseen. The
odometer and the state of charge still tell on it. EVBook records those events
as **reconstructed** and says only what it knows: when they happened *between*,
how far the car went, how much charge it gained — never a duration it did not
measure, and never a cost of 0 for one nobody priced.

## Preconditions

- Five days ago in the seeded world: the morning commute began six minutes
  before its first sample (a bounded start); the car then went offline at the
  office, and the drive home and the night's charge at home happened unseen.

## Steps

| # | Step | Expected |
|---|------|----------|
| 1 | Open the drive list | The morning commute's start reads as a range ("08:06–08:12 → …"); the drive home is marked Reconstructed, reads "Happened between …", and has no duration |
| 2 | Open the reconstructed drive | The header says when it happened between and why it is reconstructed; the map joins the two places the car was read at; there is no telemetry chart and no GPX |
| 3 | Open the charging list | The night's charge is marked Reconstructed, with no duration or energy, and a cost range from the home tariff |

## Screens

`screens/desktop`, `screens/mobile` — one numbered PNG per step above.
`video/` — the whole flow as a screencast.
