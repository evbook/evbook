# User stories

One folder per story, grouped by category. Each folder holds the story in prose
(`story.md`), the Playwright spec that walks it, and the artifacts that walking it
produced:

```
<category>/<story>/
  story.md                     what the user is trying to do, step by step
  *.spec.ts                    the same steps, executed
  screens/desktop/NN-step.png  1280×800
  screens/mobile/NN-step.png   393×852 (iPhone 16 portrait)
  video/desktop.webm           screencast of the whole story
  video/mobile.webm
```

The numbered screenshots line up with the numbered steps in `story.md`.

| Category | Story | Covers |
|---|---|---|
| Access | [Sign in and connect a Tesla account](01-access/01-sign-in/story.md) | app password, wrong password, make picker, Tesla token validation, car accounts |
| Live | [Check on the car at a glance](02-live/01-overview-at-a-glance/story.md) | overview card, live polling, parked → charging → driving |
| Live | [Wake the car and send it somewhere](02-live/02-wake-and-navigate/story.md) | diagnostics section, wake command, send destination (write) |
| Driving | [Find a particular drive in the history](03-driving/01-browse-drive-history/story.md) | date presets, search, sorting, combined route map, totals |
| Driving | [Inspect a single drive](03-driving/02-inspect-a-drive/story.md) | route map, speed/power, battery, temperature charts |
| Driving | [See how a road trip went](03-driving/03-a-trip-rolled-up/story.md) | drives grouped into journeys, stops, trip map and state band |
| Driving | [See what happened while nobody was watching](03-driving/04-what-nobody-saw/story.md) | bounded start times, reconstructed drives and charges, cost ranges |
| Charging | [Review charging sessions and what they cost](04-charging/01-browse-charging-sessions/story.md) | AC/DC filter, energy and cost totals, sorting |
| Charging | [Inspect a fast charge and correct its price](04-charging/02-inspect-and-price-a-charge/story.md) | DC taper curve, cost override (write) |
| Analytics | [See what driving costs per month](05-analytics/01-usage-and-cost/story.md) | day/week/month/year grouping, AC vs DC, top locations |
| Analytics | [Check whether the battery is degrading](05-analytics/02-battery-health/story.md) | capacity trend, degradation, idle loss, updates |
| Analytics | [See whether the car is sleeping, and how charged it sat](05-analytics/03-history/story.md) | state band, asleep vs awake shares, charge-level history, window switching |
| Analytics | [Notice a slow leak before it becomes a flat](05-analytics/04-tyre-pressure/story.md) | tyre tile vs recommended pressure, statuses, pressure history per axle with gaps, attention dot on the nav |
| Places | [Name a place and price its electricity](06-places/01-manage-places/story.md) | geo-fence create / edit / delete (write) |
| Places | [Put home charging on an off-peak tariff](06-places/02-time-of-use-tariff/story.md) | dated prices, "New price from…", time windows and the week preview, a ranged cost and its explanation (write) |
| Settings | [Switch to miles and tune the sleep settings](07-settings/01-units-and-sleep/story.md) | global units propagating, per-car sleep settings (write) |
| Import | [Bring years of TeslaMate history along](08-import/01-bring-teslamate-history/story.md) | TeslaMate backup detection, import, the imported-backups list, delete (write) |

## Adding a story

1. `mkdir -p e2e/stories/<category>/<NN-slug>` and write `story.md` — the
   **Category** / **Persona** / **Spec** header, why it matters, preconditions,
   and the steps as a table, because the spec mirrors them.
2. Add `<name>.spec.ts` next to it:

   ```ts
   import { expect, step, test } from "../../../harness/story";

   test("what the user achieves", async ({ page, story }) => {
     await step("the first thing they do", async () => {
       await story.goto("/some-page");
       await expect(page.getByRole("heading", { name: "…" })).toBeVisible();
       await story.shot("what this screenshot shows");
     });
   });
   ```

3. If the story needs data that does not exist yet, add it to
   [`../mocks/world.mjs`](../mocks/world.mjs) rather than to the test.
4. `bun run e2e` — screens and video appear in the story folder.

Stories that write to the database should put things back the way they found
them; the suite runs them in one Playwright worker against one seeded database, in file
order.

What belongs in a story at all — and what belongs in a unit test next to the code
instead — is in [`../../docs/testing.md`](../../docs/testing.md).
