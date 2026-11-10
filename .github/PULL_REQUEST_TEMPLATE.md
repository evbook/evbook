<!-- The title becomes the commit when this is squash-merged: a sentence about
     what changes for the person using the app. -->

## What changes

<!-- What this does and why. Link the issue it closes, if there is one. -->

## How it was tested

<!-- Commands you ran, and what you looked at in the app. -->

- [ ] `bun run test`, `bun run typecheck` and `bun run lint` pass
- [ ] `bun run format` leaves nothing changed
- [ ] If a screen changed: `bun run e2e` ran, and the screenshots of the stories it touched are committed
- [ ] If dependencies changed: `bun run lock:npm` ran
- [ ] Docs updated where the behaviour they describe changed
