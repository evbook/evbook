# Inspect a single drive

**Category** Driving
**Persona** Owner curious why one trip used more energy than usual
**Spec** [`drive-detail.spec.ts`](drive-detail.spec.ts)

## Why it matters

The detail page is where the logged samples pay off: the route on a map, the
extremes in tiles, and one telemetry chart the owner composes — any of speed,
power, battery, range, elevation and the two temperatures over time or distance,
remembered from drive to drive.

## Preconditions

- The 186 km Leipzig road trip is in the seeded history, with ~22 samples.

## Steps

| # | Step | Expected |
|---|------|----------|
| 1 | Open the road trip from the list | Header names both ends; tiles show distance, duration, consumption, battery, and the max/min/average extremes |
| 2 | Look at the route map | The traced path is drawn between start and end markers |
| 3 | Look at the telemetry chart | Speed and power are on, each with its own colored axis |
| 4 | Switch battery and elevation on | Four lines share the panel; the axes give way to full-height scales |
| 5 | Switch the x-axis to distance and reload | Ticks read as kilometres, and the whole setup survives the reload |

## Screens

`screens/desktop`, `screens/mobile` — one numbered PNG per step above.
`video/` — the whole flow as a screencast.
