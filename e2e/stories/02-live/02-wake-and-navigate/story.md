# Wake the car and send it somewhere

**Category** Live
**Persona** Owner about to leave, wanting the car awake and knowing where to go
**Spec** [`wake-and-navigate.spec.ts`](wake-and-navigate.spec.ts)

## Why it matters

These are the only two commands the Owner API still takes unsigned, so they are
the only two buttons the card has that reach the car rather than the logger. A
sleeping car must be wakeable from the page, and an address must land in its
navigation the way sharing from a phone does. The diagnostics section rides
along: it is the same card, and an asleep car has to keep showing its last
readings rather than a blank.

## Preconditions

- The mock car can be put to sleep and answers `wake_up` by coming back online.
- The mock records the last destination shared to it.

## Steps

| # | Step | Expected |
|---|------|----------|
| 1 | Open the overview with the car parked | Card is Online; Diagnostics is collapsed |
| 2 | Expand Diagnostics | Tyre pressures, doors and windows are listed |
| 3 | Put the car to sleep | Badge shows Asleep; a Wake button appears; Navigate is disabled |
| 4 | Press Wake | The card comes back Online |
| 5 | Send a destination | The dialog closes; the mock records the address |

## Screens

`screens/desktop`, `screens/mobile` — one numbered PNG per step above.
`video/` — the whole flow as a screencast.
