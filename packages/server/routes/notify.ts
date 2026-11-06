import { Hono } from "hono";
import type {
  PushSubscriptionKeys,
  PushSubscriptionRecord,
} from "@lumisca/core";
import { AppError, parseBody, requireNonEmptyString } from "./util.ts";

/** The slice of the core (and the notifier) these routes need. */
export interface PushApi {
  listPushSubscriptions(): PushSubscriptionRecord[];
  addPushSubscription(
    input: { endpoint: string; keys: PushSubscriptionKeys },
  ): PushSubscriptionRecord;
  removePushSubscription(endpoint: string): boolean;
  pushVapidKeys(): Promise<{ publicKey: string }>;
  /** Sends a notification to the stored subscriptions right now (the
   * settings page's "send a test"): a user who enabled notifications needs a
   * way to find out whether the channel works without waiting for a run. */
  sendPushTest(): Promise<number>;
}

/** One subscription as a client posts it. The endpoint and both keys are
 * strings; everything else the store derives (the timestamp). */
function subscriptionInput(
  value: unknown,
): { endpoint: string; keys: PushSubscriptionKeys } {
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
export function notifyRoutes(api: PushApi): Hono {
  const app = new Hono();

  app.get("/notify/key", async (c) => {
    // Created on the first ask (see core/notify/vapid.ts): a server whose user
    // never enables notifications stores no secret.
    const keys = await api.pushVapidKeys();
    return c.json({ publicKey: keys.publicKey });
  });

  app.get("/notify/subscriptions", (c) => {
    // Only the endpoints, never the keys: the settings page counts the
    // devices it notifies, and a key is not something a page needs to draw.
    return c.json({
      count: api.listPushSubscriptions().length,
    });
  });

  app.post("/notify/subscriptions", async (c) => {
    const body = await parseBody<unknown>(c);
    const record = api.addPushSubscription(subscriptionInput(body));
    return c.json({ ok: true, endpoint: record.endpoint });
  });

  app.delete("/notify/subscriptions", async (c) => {
    const body = await parseBody<{ endpoint?: unknown }>(c);
    const endpoint = requireNonEmptyString(body?.endpoint, "endpoint (string)");
    // A browser that unsubscribes on its own, or an entry a previous install
    // left behind, must not make this fail: the desired state is "not
    // subscribed", and it already holds.
    return c.json({ ok: true, removed: api.removePushSubscription(endpoint) });
  });

  app.post("/notify/test", async (c) => {
    const delivered = await api.sendPushTest();
    return c.json({ ok: true, delivered });
  });

  return app;
}
