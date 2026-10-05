# Switch to miles and tune the sleep settings

**Category** Settings
**Persona** Owner in the UK who also wants the car left alone at night
**Spec** [`settings.spec.ts`](settings.spec.ts)

## Why it matters

Units are a global preference that every other page reads, so getting it wrong is
visible everywhere. The sleep settings are the ones that decide how aggressively
the logger polls — the difference between a rested car and a flat one. The
data-health card at the bottom is the page you land on when something feels wrong:
it says how much history is stored, whether any session was left half-written, and
offers every table as CSV so nothing is trapped in here.

## Preconditions

- Global settings seeded as km / °C / bar / rated range / Europe/Berlin.

## Steps

| # | Step | Expected |
|---|------|----------|
| 1 | Open Settings | General and per-car cards, saving immediately |
| 2 | Switch distance to miles | The setting sticks |
| 3 | Check the drives list | Distances are shown in miles |
| 4 | Back in Settings, raise the idle timeout | The new value is saved |
| 5 | Read the data-health card | Row counts, each a CSV download, and nothing truncated |
| 6 | Switch back to kilometres | Left as the other stories expect it |

## Screens

`screens/desktop`, `screens/mobile` — one numbered PNG per step above.
`video/` — the whole flow as a screencast.
