#!/usr/bin/env node
/**
 * Fixture server for `npm run dev` — impersonates the Tesla Owner API so
 * EVBook can be developed without a car.
 *
 *   node scripts/fake-tesla.mjs [--port 9099] [--scenario parked|driving|charging|asleep]
 *
 * The implementation lives in e2e/mocks/server.mjs, which the end-to-end suite
 * uses too, so there is only one mock world to maintain. It also serves OSM
 * Nominatim, so add all three lines to .dev.vars:
 *
 *   TESLA_API_HOST=http://localhost:9099
 *   TESLA_AUTH_ISSUER=http://localhost:9099/oauth2/v3
 *   NOMINATIM_HOST=http://localhost:9099
 *   ELEVATION_HOST=http://localhost:9099
 *
 * Then sign in with any non-empty token pair, and change what the car is doing:
 *   curl -X POST localhost:9099/scenario/driving
 */

import { createMockServer } from "../e2e/mocks/server.mjs";

const args = process.argv.slice(2);
const readFlag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const port = Number(readFlag("--port") ?? 9099);
const scenario = readFlag("--scenario") ?? "parked";

const { server, manifest } = createMockServer({
  manifestPath: readFlag("--manifest") ?? "e2e/.artifacts/manifest.json",
  scenario,
});

server.listen(port, () => {
  console.log(`Fake Tesla API + Nominatim on http://localhost:${port} (scenario: ${scenario})`);
  console.log(`  car: ${manifest.car.name}`);
});
