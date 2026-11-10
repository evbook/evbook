/**
 * Registers `/sw.js`, which the build emits (see `vite.config.ts`).
 *
 * Only from a build. `bun run dev:app` serves the app out of Vite's memory and
 * has no `sw.js` to register at all — and it tears down any worker it does find
 * rather than just declining to add one, so that a build previously served on
 * the dev server's own origin cannot leave one behind answering for files that
 * no longer exist.
 */
export function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;

  if (!import.meta.env.PROD) {
    void navigator.serviceWorker.getRegistrations().then((all) => all.forEach((r) => void r.unregister()));
    return;
  }

  // After `load`, so registering never competes with the first render for
  // bandwidth — the point of the worker is the *next* visit.
  window.addEventListener("load", () => {
    // A failure here costs nothing that matters: an unregistered worker just
    // means no offline shell, and the app is already running.
    void navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}
