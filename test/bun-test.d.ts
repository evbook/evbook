// The `bun:test` module, and nothing else of Bun's. Specs that run under `bun test`
// import from it, but they are checked by the same project as the code they
// cover — workerd globals for src/ and shared/, Node's for src/platform/node, the
// DOM for app/. Pulling in all of bun-types would hand that code Bun's globals
// too, and the point of the separate projects is that it cannot lean on them.
/// <reference types="bun-types/test" />
