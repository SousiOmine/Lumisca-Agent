/**
 * Web Push from the page: asking for permission, subscribing this device, and
 * telling the server about it.
 *
 * The channel has three parts and each lives where it can see what it needs:
 *
 *   - this module subscribes the device (the browser's own `PushManager`),
 *     which is the only place a user gesture can start,
 *   - the service worker shows what arrives (`public/sw.js`), because only it
 *     can ask whether a window of the app is on screen,
 *   - the server encrypts and sends (`server/push.ts`), because it is where
 *     the events happen.
 *
 * Subscribing needs a secure origin and a registered worker, which is exactly
 * `shouldRegisterServiceWorker`: the desktop shell (a loopback http origin)
 * and the Vite dev server are excluded by the same rule, and in both the
 * desktop's own OS notifications are what the user has.
 */
import { fromBase64Url } from "@lumisca/core/shared";
import { request } from "./api-client.ts";
import { shouldRegisterServiceWorker } from "./pwa.ts";
import { inDesktopShell } from "./shell.ts";

/** What the settings row needs to know. */
export type PushState = "unsupported" | "denied" | "off" | "on";

/** Whether a browser with this origin can use Web Push. Pure, so the rule is
 * testable: a secure origin with the app's worker (the same rule that decides
 * whether a worker exists at all), plus the Push API. Safari on iOS has the
 * API only inside a home-screen PWA, so an ordinary tab answers false — which
 * is the truth the settings row has to explain. */
export function canUsePush(options: {
  protocol: string;
  shell: boolean;
  /** Whether the browser exposes `serviceWorker`, `PushManager` and
   * `Notification`. */
  api: boolean;
}): boolean {
  if (!shouldRegisterServiceWorker(options.protocol, options.shell)) {
    return false;
  }
  return options.api;
}

/** Whether this page can use Web Push (see {@link canUsePush}). */
export function pushSupported(): boolean {
  if (typeof location === "undefined") return false;
  return canUsePush({
    protocol: location.protocol,
    shell: inDesktopShell(),
    api: "serviceWorker" in navigator && "PushManager" in globalThis &&
      "Notification" in globalThis,
  });
}

/** This device's push subscription, or null when it has none. Never throws:
 * a worker that has not activated yet or a browser that forbids the query
 * both read as "not subscribed". */
export async function readSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  try {
    const registration = await navigator.serviceWorker.getRegistration("/");
    if (registration === undefined) return null;
    return await registration.pushManager.getSubscription();
  } catch {
    return null;
  }
}

function endpointBody(subscription: PushSubscription): {
  endpoint: string;
  keys: { p256dh: string; auth: string };
} {
  const json = subscription.toJSON();
  const keys = json.keys ?? {};
  const p256dh = keys.p256dh;
  const auth = keys.auth;
  if (p256dh === undefined || auth === undefined) {
    // A subscription without both keys cannot be encrypted for. Refusing here
    // keeps an unusable row out of the server's list.
    throw new Error("the push subscription carries no keys");
  }
  return { endpoint: subscription.endpoint, keys: { p256dh, auth } };
}

/** Tell the server about a subscription this browser already has. Used after
 * subscribing here, and on page load when the browser holds one the server
 * may not know about (a re-posts after `pushsubscriptionchange` never fired,
 * and a server reset that kept the browser's copy). */
export async function postSubscription(
  subscription: PushSubscription,
): Promise<void> {
  await request<{ ok: boolean }>("/api/notify/subscriptions", {
    method: "POST",
    body: JSON.stringify(endpointBody(subscription)),
  });
}

/** The current state of this device, as the settings row draws it. Reads the
 * browser's own permission first: a user who blocked notifications on this
 * site cannot be asked again from here, and the row must say so rather than
 * offer a switch that silently does nothing. */
export async function readPushState(): Promise<PushState> {
  if (!pushSupported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  const subscription = await readSubscription();
  return subscription === null ? "off" : "on";
}

/** Ask for permission, subscribe, and register with the server. Returns the
 * new state; a failure is thrown for the caller to show.
 *
 * The order matters: `requestPermission` must run in the user's gesture (a
 * toggle click), so it is the first await, and a refusal returns immediately
 * without subscribing anything. */
export async function enablePush(): Promise<PushState> {
  if (!pushSupported()) return "unsupported";
  const permission = Notification.permission === "granted"
    ? "granted"
    : await Notification.requestPermission();
  if (permission !== "granted") {
    return permission === "denied" ? "denied" : "off";
  }
  // The key is what the browser stores in the subscription and what it
  // verifies each message against, so it is read first.
  const { publicKey } = await request<{ publicKey: string }>("/api/notify/key");
  const registration = await navigator.serviceWorker.getRegistration("/") ??
    await navigator.serviceWorker.register("/sw.js");
  const subscription = await registration.pushManager.subscribe({
    // Required by every browser: each push must show something to the user.
    userVisibleOnly: true,
    applicationServerKey: fromBase64Url(publicKey),
  });
  try {
    await postSubscription(subscription);
  } catch (error) {
    // The browser is now subscribed to something the server does not know
    // about. Leaving it would show "on" next to a channel that never
    // delivers, so it is undone before the failure is reported.
    await subscription.unsubscribe().catch(() => {});
    throw error;
  }
  return "on";
}

/** Unsubscribe this device and forget it on the server. A failed DELETE is
 * not an error the user can act on (the browser side is already off), so it
 * is reported by the caller's error line only when the unsubscribe itself
 * fails. */
export async function disablePush(): Promise<PushState> {
  const subscription = await readSubscription();
  if (subscription === null) return "off";
  const { endpoint } = subscription;
  await subscription.unsubscribe();
  await request<{ ok: boolean }>("/api/notify/subscriptions", {
    method: "DELETE",
    body: JSON.stringify({ endpoint }),
  }).catch(() => {});
  return "off";
}

/** Send a test notification through the server, so the user finds out whether
 * the channel works now rather than at the end of the next long run. */
export async function sendTestPush(): Promise<number> {
  const { delivered } = await request<{ delivered: number }>(
    "/api/notify/test",
    { method: "POST" },
  );
  return delivered;
}
