import { registerSource } from "./registry";
import { tessieSource } from "./adapters/tessie";

/**
 * The built-in adapters, and the only import module the SPA pulls in.
 *
 * Detection and parsing are pure and portable, so the browser runs them on the
 * file the user picked — before uploading anything — to show which service the
 * export came from and which car it belongs to. Keeping registration here rather
 * than in `index.ts` is what makes that possible: `index.ts` reaches the database
 * and would drag the Worker's types into the SPA's build.
 */

registerSource(tessieSource);

export { detectSources, getSource, listSources } from "./registry";
