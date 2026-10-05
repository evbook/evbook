/**
 * The service worker: what makes the installed app start without a network and
 * survive a dead spot — which, for something you open in a car park, is the
 * whole point of installing it.
 *
 * It is deliberately not built by Vite. The two placeholders below are filled in
 * by the `service-worker` plugin in `vite.config.ts`, which knows the hashed
 * filenames the build just produced; until it runs they are strings, so this file
 * stays valid JavaScript that lint and an editor can both read.
 *
 * Two rules keep this honest:
 *
 *   - `/api/*` is not touched at all — not cached, and not answered. Every
 *     response under it is either the logbook or a signed-in user's export, so
 *     nothing user-specific is ever written to a cache the next person to open
 *     this browser could read. What the cache holds is the shell and the bundle,
 *     which are the same bytes for every visitor and for a signed-out one.
 *   - Leaving it unanswered is also what keeps the CSV and GPX download links
 *     working. Clicking one is a navigation, and the navigation branch below
 *     falls back to the app shell — so on a slow connection a download would
 *     otherwise arrive as an HTML file named `drive.gpx`.
 */

/** @type {string[]} filled in at build time — every asset of this build, plus "/". */
const PRECACHE = "__PRECACHE__";
/** Keyed off the file list *and* this file, so either changing retires the old cache. */
const CACHE = "evbook-__VERSION__";

/** How long a navigation waits for the network before the cached shell answers. */
const SHELL_TIMEOUT_MS = 2500;

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // `reload` so a stale HTTP cache entry cannot be promoted into the shell.
      await cache.addAll(PRECACHE.map((url) => new Request(url, { cache: "reload" })));
      // Take over from the previous worker now rather than waiting for every tab
      // to close. Safe here because the build is a single bundle: there are no
      // lazily-imported chunks for an already-open page to ask for after its
      // deploy has been swept away.
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  // Map tiles, the geocoder, the elevation service: someone else's cache policy.
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname === "/health_check") return;
  // The browser fetches this outside the fetch handler when it checks for an
  // update, so a copy in here would never be the one that matters — but it would
  // be a stale copy of the worker sitting in the worker's own cache. Skip it.
  if (url.pathname === "/sw.js") return;

  if (request.mode === "navigate") event.respondWith(shell(request));
  else event.respondWith(asset(request));
});

/**
 * Navigations go to the network first so a deploy is picked up on the next load
 * rather than the one after it, and so a rebuild during `npm run dev` shows up
 * immediately. The cached shell steps in when the network fails or dawdles —
 * every route renders the same `index.html`, so it is always the right answer.
 */
async function shell(request) {
  const network = fetch(request);
  // Losing the race below does not cancel the fetch, and a rejection nobody is
  // listening for is an unhandled one. This is that listener; the `catch` on the
  // race is what actually decides the answer.
  network.catch(() => {});
  try {
    return await Promise.race([
      network,
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), SHELL_TIMEOUT_MS)),
    ]);
  } catch {
    return (await caches.match("/", { cacheName: CACHE })) ?? Response.error();
  }
}

/**
 * The bundle, the icons and the manifest: cache first. Their names carry a
 * content hash, so a cached one is never the wrong one, and a name that is not
 * in the cache is from a build this worker has not installed — fetch it, and
 * keep it, so a font or an image reached for later is there offline too.
 */
async function asset(request) {
  const cached = await caches.match(request, { cacheName: CACHE });
  if (cached) return cached;

  const response = await fetch(request);
  if (response.ok && response.type === "basic") {
    const copy = response.clone();
    // Not awaited: the page should not wait on the disk write.
    caches.open(CACHE).then((cache) => cache.put(request, copy));
  }
  return response;
}
