# Bring years of TeslaMate history along

**Category** Import
**Persona** TeslaMate user moving to EVBook who does not want to start from zero
**Spec** [`teslamate.spec.ts`](teslamate.spec.ts)

## Why it matters

EVBook pitches itself as the lightweight TeslaMate alternative, and the first
question anyone switching asks is what happens to the years TeslaMate already
logged. The answer is the backup TeslaMate's own documentation has them make —
`pg_dump` to `teslamate.bck` — uploaded as it is, with nothing running and no
database to reach. History from before EVBook started logging the car comes
across; anything overlapping what EVBook already has is left out and counted,
and the whole import can be taken back out again.

## Preconditions

- The seeded car, with about seventy days of EVBook's own history.
- A hand-written TeslaMate backup (`test/teslamate-dump.ts`) of the same car from
  2020, in an early TeslaMate schema, built into the spec — no real data.

## Steps

| # | Step | Expected |
|---|------|----------|
| 1 | Open the import page | Both services are offered, with TeslaMate's backup command |
| 2 | Pick `teslamate.bck` | Recognised as a TeslaMate export for the seeded car's VIN, before anything is uploaded |
| 3 | Start the import | It finishes, with the drive and charging session it found |
| 4 | Look at the imported backups | The import is listed for the car, with its period and counts |
| 5 | Delete it | Confirmed, and the list is empty again — the car's own history is untouched |

## Screens

`screens/desktop`, `screens/mobile` — one numbered PNG per step above.
`video/` — the whole flow as a screencast.
