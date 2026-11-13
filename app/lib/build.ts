/**
 * Which commit this copy of the app was built from: the short git revision and
 * when it was committed. Stamped in by the bundler (`vite.config.ts`), so it is
 * absent — both fields null — wherever the code runs unbundled, a test for one,
 * and in a build made with no repository to ask.
 */
export interface BuildInfo {
  revision: string | null;
  /** Epoch milliseconds. */
  committedAt: number | null;
}

declare const __BUILD__: BuildInfo | undefined;

export const BUILD: BuildInfo = typeof __BUILD__ === "undefined" ? { revision: null, committedAt: null } : __BUILD__;
