# See whether the car is sleeping, how charged it sat, and what actually happened

**Category** Analytics
**Persona** Owner who suspects the logger is keeping the car awake, wants to know
whether they are leaving the pack sitting too full, and then wants to read back
what the car did last week
**Spec** [`history.spec.ts`](history.spec.ts)

## Why it matters

The hard part of logging a Tesla is that polling it keeps it awake. EVBook ports
TeslaMate's sleep-preservation state machine, and this page is the only place the
result of that machine is visible: a band of asleep, awake, driving, charging and
updating over a window you choose.

The charge-level chart beneath it answers the other question a logger is installed
for — "am I leaving it at 90% for days at a time?" — which is the biggest thing an
owner actually controls about degradation. Health shows the degradation; this shows
the cause.

The timeline underneath is the same history read the other way round. The band shows
the *shape* of a window and can only be hovered; the timeline lists what the window
actually contained, one row per event, and is the only place a sleep span or a
firmware install can be read rather than pointed at. It is also how you check that
an [import](../../../../docs/import.md) landed: a week that should hold drives, charges
and sleep, and instead holds only drives, is obvious here and invisible everywhere
else.

## Preconditions

- Ten weeks of seeded history: sleep transitions, drives, charges, idle samples
  and two software updates. It stops yesterday, which is why step 7 steps back a
  month before reading the log: on the first of a month, "this month" holds nothing
  and an empty log would be the correct answer rather than a useful one.
- The car is parked and awake where the live story picks it up, so "Now" has
  something to report.

## Steps

| # | Step | Expected |
|---|------|----------|
| 1 | Open History | The current state, asleep share, awake-and-idle share and average charge level are filled in |
| 2 | Look at the state band | A band of spans with a legend naming each state and how long it ran |
| 3 | Look at the charge level | A charge-level line, with the lowest, highest and time-at-high-SoC figures beneath it |
| 4 | Narrow the window to the last 24 hours | The band and the chart both redraw over the shorter window |
| 5 | Step back a day | The forward arrow becomes usable again |
| 6 | Widen it to the month | Buckets widen, and the tick labels switch from times to dates |
| 7 | Step back a month and read the timeline | One row per drive, charge, sleep span, offline stretch and firmware install, newest first, with a running count |
| 8 | Click a drive in the log | Its own detail page opens; going back returns to the log |
| 9 | Search for "Home" | Only rows naming that place remain, and the spans that carry no place drop out |
| 10 | Clear the search, switch off Asleep and Offline | The sleep noise goes, the narrowing appears in the URL |
| 11 | Widen to the year and load more | The next chunk is appended to what was already read |
| 12 | Look at a firmware install in the log | Its version links out to that release's notes on notateslaapp, in a new tab |

## Screens

`screens/desktop`, `screens/mobile` — one numbered PNG per step above.
`video/` — the whole flow as a screencast.
