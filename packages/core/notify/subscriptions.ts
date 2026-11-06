/**
 * Web Push subscriptions this server notifies.
 *
 * The service owns the stored list and the VAPID pair, so the route and the
 * notifier share one answer to "who do we send to?" and one place that decides
 * what a valid subscription is. Sending itself lives in web-push.ts (the
 * protocol) and server/push.ts (which events become messages).
 */
import type { SettingsRepo } from "../settings/repo.ts";
import { PUSH_SUBSCRIPTIONS_KEY } from "../shared/settings-keys.ts";
import {
  isPushEndpoint,
  parsePushSubscriptions,
  PUSH_KEY_MAX_CHARS,
  type PushSubscriptionKeys,
  type PushSubscriptionRecord,
  serializePushSubscriptions,
} from "../shared/push.ts";
import { CoreError } from "../errors.ts";
import { loadVapidKeys, type VapidKeys } from "./vapid.ts";

/** What a client posts to subscribe. Validated here, not at the route: the
 * rules (a usable endpoint, base64 keys) belong with the record they make. */
export interface PushSubscriptionInput {
  endpoint: string;
  keys: PushSubscriptionKeys;
}

function validate(input: PushSubscriptionInput): PushSubscriptionRecord {
  if (!isPushEndpoint(input.endpoint)) {
    throw new CoreError(
      "A push subscription needs an https endpoint",
      "invalid",
    );
  }
  const { p256dh, auth } = input.keys;
  for (const [name, value] of [["p256dh", p256dh], ["auth", auth]] as const) {
    if (
      typeof value !== "string" || value.length === 0 ||
      value.length > PUSH_KEY_MAX_CHARS
    ) {
      throw new CoreError(
        `A push subscription needs a valid ${name}`,
        "invalid",
      );
    }
  }
  return {
    endpoint: input.endpoint,
    keys: { p256dh, auth },
    createdAt: Date.now(),
  };
}

export class PushSubscriptions {
  constructor(private readonly settings: SettingsRepo) {}

  /** The stored subscriptions, oldest first. */
  list(): PushSubscriptionRecord[] {
    return parsePushSubscriptions(this.settings.get(PUSH_SUBSCRIPTIONS_KEY));
  }

  /** Store a subscription. Re-subscribing the same endpoint replaces the keys
   * (a browser refreshes them when it renews) instead of adding a second row,
   * which would send every message twice. */
  add(input: PushSubscriptionInput): PushSubscriptionRecord {
    const record = validate(input);
    const others = this.list().filter((e) => e.endpoint !== record.endpoint);
    this.settings.set(
      PUSH_SUBSCRIPTIONS_KEY,
      serializePushSubscriptions([...others, record]),
    );
    return record;
  }

  /** Forget one endpoint. Returns whether it was there: a browser that
   * unsubscribes on its own must be able to make the same call twice. */
  remove(endpoint: string): boolean {
    const current = this.list();
    const next = current.filter((entry) => entry.endpoint !== endpoint);
    if (next.length === current.length) return false;
    this.settings.set(PUSH_SUBSCRIPTIONS_KEY, serializePushSubscriptions(next));
    return true;
  }

  /** Forget the subscriptions a push service reported gone (404 / 410). The
   * notifier calls this after a send, so a dead endpoint costs one failure and
   * never another. */
  removeEndpoints(endpoints: readonly string[]): void {
    if (endpoints.length === 0) return;
    const gone = new Set(endpoints);
    const current = this.list();
    const next = current.filter((entry) => !gone.has(entry.endpoint));
    if (next.length === current.length) return;
    this.settings.set(PUSH_SUBSCRIPTIONS_KEY, serializePushSubscriptions(next));
  }

  /** The VAPID pair, created on first use (see vapid.ts). */
  vapidKeys(): Promise<VapidKeys> {
    return loadVapidKeys(this.settings);
  }
}
