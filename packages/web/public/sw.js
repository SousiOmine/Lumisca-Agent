/**
 * The service worker.
 *
 * It exists for one reason: Chromium only offers the install prompt — and,
 * behind it, a WebAPK (a real home-screen app rather than a shortcut) — to a
 * site with a registered worker that has a fetch handler. What it caches is
 * only the app's own static files: the client bundle's chunks, the icons and
 * the manifest, always network-first, so a release is never served from
 * yesterday's copy.
 *
 * Three things are deliberately absent:
 *   - the page (`/`), which carries the auth token and is answered
 *     `no-store`; a cached copy would keep a browser authenticated with a
 *     token the server may already have replaced,
 *   - `/api/*`, whose answers are per-session and change by the second,
 *   - `/ws`, which a worker cannot intercept anyway.
 *
 * Nothing here makes the app work offline — it drives an agent on the
 * server — so the cache only saves the transfer of the files a flaky
 * tailnet would otherwise drop mid-load.
 */

/** The prefix every cache this app owns carries, and the one it uses now.
 * Bump the version when the policy changes: activating a new worker deletes
 * the older ones under the same prefix, and nothing else. */
const CACHE_PREFIX = "lumisca-static-";
const CACHE_NAME = `${CACHE_PREFIX}v1`;

/** Whether this worker owns the path. Everything else goes to the network
 * untouched, so the worker can never change the behaviour of the app's own
 * traffic. */
function isStaticAsset(pathname) {
  if (pathname === "/manifest.webmanifest" || pathname === "/favicon.png") {
    return true;
  }
  if (pathname.startsWith("/pwa/")) return true;
  // The client build's chunks. `initial-data.js` is excluded by name: it
  // carries the auth token.
  return pathname.startsWith("/assets/") &&
    pathname.endsWith(".js") &&
    !pathname.endsWith("/initial-data.js");
}

/** Whether the server asked for the answer not to be kept. The page's own
 * policy for anything carrying a token is `no-store`, and this honours it so
 * the cache can only ever hold what the server allows. */
function isNoStore(response) {
  return (response.headers.get("cache-control") ?? "").includes("no-store");
}

self.addEventListener("install", (event) => {
  // Take over immediately: nothing here is stateful, and waiting would leave
  // the previous policy in place until every tab has been closed.
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) =>
            name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME
          )
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  // Navigations and form posts are not this worker's business.
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (!isStaticAsset(url.pathname)) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      try {
        // Network first: the next load after a release has to see it. The
        // cached copy is what a load gets when the network fails.
        const response = await fetch(request);
        if (response.ok && !isNoStore(response)) {
          await cache.put(request, response.clone());
        }
        return response;
      } catch (error) {
        const cached = await cache.match(request);
        if (cached !== undefined) return cached;
        // Nothing cached: report the network failure as the browser would.
        throw error;
      }
    })(),
  );
});
