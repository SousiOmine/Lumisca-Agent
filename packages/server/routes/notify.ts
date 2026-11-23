import type {
  PushSubscriptionKeys,
  PushSubscriptionRecord,
} from "@lumisca/core";
import { Hono } from "hono";
import { AppError, parseBody, requireNonEmptyString } from "./util.ts";

/** The stored subscriptions (`core.services.push`). Declared by the method
 * names the routes call rather than restated in the app: the route is handed
 * the service itself. */
export interface PushApi {
  list(): PushSubscriptionRecord[];
  add(input: {
    endpoint: string;
    keys: PushSubscriptionKeys;
  }): PushSubscriptionRecord;
  remove(endpoint: string): boolean;
  vapidKeys(): Promise<{ publicKey: string }>;
}

/** One subscription as a client posts it. The endpoint and both keys are
 * strings; everything else the store derives (the timestamp). */
function subscriptionInput(value: unknown): {
  endpoint: string;
  keys: PushSubscriptionKeys;
} {
  if (typeof value !== "object" || value === null) {
    throw new AppError("a subscription must be an object", 400);
  }
  const body = value as Record<string, unknown>;
  const keys = body.keys as Record<string, unknown> | undefined;
  if (typeof keys !== "object" || keys === null) {
    throw new AppError("keys (object) is required", 400);
  }
  return {
    endpoint: requireNonEmptyString(body.endpoint, "endpoint (string)"),
    keys: {
      p256dh: requireNonEmptyString(keys.p256dh, "keys.p256dh (string)"),
      auth: requireNonEmptyString(keys.auth, "keys.auth (string)"),
    },
  };
}

/**
 * The PWA notification surface: the VAPID public key a client subscribes
 * with, and the subscription list it adds to.
 *
 * All of it is under `/api`, so the token guard and the Host guard apply: a
 * subscription endpoint is a capability to wake that device, and it must not
 * be writable by anything that can merely reach the port. The public key is
 * the one value here that is safe to hand out — it is sent to the browser in
 * every subscription anyway — while the private half never leaves the server.
 */
export function notifyRoutes(
  push: PushApi,
  /** The notifier's test send (see push.ts): the one route that delivers
   * without waiting for a run. */
  sendTest: () => Promise<number>,
): Hono {
  const app = new Hono();

  app.get("/notify/key", async (c) => {
    // Created on the first ask (see core/notify/vapid.ts): a server whose user
    // never enables notifications stores no secret.
    const keys = await push.vapidKeys();
    return c.json({ publicKey: keys.publicKey });
  });

  app.get("/notify/subscriptions", (c) => {
    // Only the endpoints, never the keys: the settings page counts the
    // devices it notifies, and a key is not something a page needs to draw.
    return c.json({
      count: push.list().length,
    });
  });

  app.post("/notify/subscriptions", async (c) => {
    const body = await parseBody<unknown>(c);
    const record = push.add(subscriptionInput(body));
    return c.json({ ok: true, endpoint: record.endpoint });
  });

  app.delete("/notify/subscriptions", async (c) => {
    const body = await parseBody<{ endpoint?: unknown }>(c);
    const endpoint = requireNonEmptyString(body?.endpoint, "endpoint (string)");
    // A browser that unsubscribes on its own, or an entry a previous install
    // left behind, must not make this fail: the desired state is "not
    // subscribed", and it already holds.
    return c.json({ ok: true, removed: push.remove(endpoint) });
  });

  app.post("/notify/test", async (c) => {
    const delivered = await sendTest();
    return c.json({ ok: true, delivered });
  });

  return app;
}
