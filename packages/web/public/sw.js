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
 *
 * The worker is also where a Web Push message is turned into a notification
 * (see the `push` listener at the end). That decision belongs here rather
 * than on the server: only this side can see whether a window of the app is
 * on screen, and a server-side guess (a "presence" the page keeps alive)
 * would be wrong the moment two devices are open.
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
  return (
    pathname.startsWith("/assets/") &&
    pathname.endsWith(".js") &&
    !pathname.endsWith("/initial-data.js")
  );
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
          .filter(
            (name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME,
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

// --- Web Push --------------------------------------------------------------
//
// The server encrypts a small JSON message (`{title, body, tag}`, see
// core/notify/web-push.ts) and posts it to this worker's push service. Three
// listeners cover the channel: what to show, what a click does, and what
// happens when the browser replaces the subscription.

/** The message a `push` event carries, or null when there is nothing to
 * show. A push whose body cannot be read still deserves a generic
 * notification: a silent drop looks like a broken app. */
function pushMessageOf(event) {
  try {
    const data = event.data?.json();
    if (data && typeof data.title === "string") {
      return {
        title: data.title,
        body: typeof data.body === "string" ? data.body : "",
        tag: typeof data.tag === "string" ? data.tag : "",
      };
    }
  } catch {
    // Not JSON, or no data at all.
  }
  return { title: "Lumisca", body: "", tag: "" };
}

/** Whether a window of this app is on screen right now. `includeUncontrolled`
 * is needed because a tab opened before this worker took over is not yet
 * under its control, and it is exactly the tab the user is looking at. */
async function hasVisibleClient() {
  const windows = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  return windows.some((client) => client.visibilityState === "visible");
}

self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      const message = pushMessageOf(event);
      // The user is looking at the app: an OS notification on top of the
      // screen that already shows the same thing is noise.
      if (await hasVisibleClient()) return;
      await self.registration.showNotification(message.title, {
        body: message.body,
        tag: message.tag,
        // Replacing a notification of the same tag must still alert: the
        // newer message is the one the user needs to see.
        renotify: message.tag !== "",
        data: { url: "/" },
        icon: "/pwa/icon-192.png",
        badge: "/pwa/icon-192.png",
      });
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      // An existing window is focused rather than a second one opened: the
      // app restores its own tabs, and a duplicate window would show the
      // same session twice.
      for (const client of windows) {
        if ("focus" in client) return await client.focus();
      }
      return await self.clients.openWindow("/");
    })(),
  );
});

/** Post a subscription to the server. The page does the same thing when the
 * user enables notifications; this copy is what re-registers after the
 * browser replaced the subscription under us. */
async function storeSubscription(subscription) {
  try {
    const response = await fetch("/api/notify/subscriptions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(subscription.toJSON()),
    });
    return response.ok;
  } catch {
    // Offline, or the server is down: the next page load re-posts what the
    // browser still holds (see hooks/usePush.ts).
    return false;
  }
}

/** The browser invalidated the subscription (a reinstall, an expired
 * endpoint, a cleared profile). Subscribe again and tell the server, or the
 * app stops notifying this device without anyone noticing.
 *
 * `newSubscription` is supplied by Chromium; Safari does not implement this
 * event at all, which is why the page re-posts on load as well. */
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      let subscription = event.newSubscription;
      if (!subscription) {
        const keyResponse = await fetch("/api/notify/key", {
          credentials: "same-origin",
        });
        if (!keyResponse.ok) return;
        const { publicKey } = await keyResponse.json();
        subscription = await self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: fromBase64Url(publicKey),
        });
      }
      await storeSubscription(subscription);
    })(),
  );
});

/** base64url to bytes — the form the server hands out a key in. A worker
 * script cannot import modules here (Safari refuses module workers), so this
 * is the one codec that exists twice; see web/src/push.ts for the page's
 * copy. */
function fromBase64Url(text) {
  const normalized = text.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
