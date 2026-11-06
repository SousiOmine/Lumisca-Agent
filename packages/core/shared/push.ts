/**
 * Web Push: the subscription records the server stores and the base64url
 * codec both sides of the channel share.
 *
 * A PWA subscribes through the browser's push service and hands the server
 * three values — an endpoint URL, the client's public key (`p256dh`) and a
 * shared secret (`auth`). The server keeps them beside the VAPID key pair it
 * signs with, and every field is base64url, so the codec lives here where the
 * bundle can use it too (the browser must hand a key to `subscribe` in the
 * same encoding it reads from the server).
 *
 * Frontend-safe (no Deno, no `node:`), like the rest of `shared/`.
 */
import { safeJsonParse } from "./misc.ts";

/** The two key values a browser's `PushSubscription` carries (`toJSON()`
 * names them `keys.p256dh` and `keys.auth`). */
export interface PushSubscriptionKeys {
  /** The subscriber's public key: an uncompressed P-256 point, base64url. */
  p256dh: string;
  /** The 16-byte shared secret, base64url. */
  auth: string;
}

/** One stored subscription: who to send to, and how to encrypt for them. */
export interface PushSubscriptionRecord {
  /** The push service URL the browser subscribed with. It identifies the
   * subscription (a re-subscribed browser gets a new one), which is why
   * removal and de-duplication are keyed by it. */
  endpoint: string;
  keys: PushSubscriptionKeys;
  /** When the server stored it (epoch ms). Only for diagnosis. */
  createdAt: number;
}

/** Longest endpoint accepted. Chrome's and Mozilla's are around 200-300
 * characters; the cap is what stops a client from parking arbitrary text in
 * the settings file. */
export const PUSH_ENDPOINT_MAX_CHARS = 2048;

/** Longest accepted `p256dh` (87 characters for a P-256 point) and `auth`
 * (22 for 16 bytes), with room for padding variants. */
export const PUSH_KEY_MAX_CHARS = 256;

/** Most subscriptions kept at once. A user may install the app on several
 * devices; past this, the oldest is dropped. Without a cap a hand-edited or
 * repeatedly re-subscribing client grows the settings file without limit. */
export const PUSH_MAX_SUBSCRIPTIONS = 32;

/** Encode bytes as base64url without padding (the JWT and VAPID spelling). */
export function toBase64Url(bytes: Uint8Array<ArrayBufferLike>): string {
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(
    /=+$/,
    "",
  );
}

/** Decode base64url (padding optional). Throws on a character outside the
 * alphabet: a key that is not base64 is not a key. */
export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const normalized = text.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Whether `value` is a push endpoint this server will send to: an absolute
 * https URL within the length cap. Everything else is refused at the route,
 * so a stored endpoint is always one `fetch` can address. */
export function isPushEndpoint(value: string): boolean {
  if (value.length === 0 || value.length > PUSH_ENDPOINT_MAX_CHARS) {
    return false;
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.host !== "";
  } catch {
    return false;
  }
}

function isSubscription(value: unknown): value is PushSubscriptionRecord {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  const keys = entry.keys as Record<string, unknown> | undefined;
  return typeof entry.endpoint === "string" && isPushEndpoint(entry.endpoint) &&
    typeof keys === "object" && keys !== null &&
    typeof keys.p256dh === "string" && keys.p256dh.length > 0 &&
    keys.p256dh.length <= PUSH_KEY_MAX_CHARS &&
    typeof keys.auth === "string" && keys.auth.length > 0 &&
    keys.auth.length <= PUSH_KEY_MAX_CHARS &&
    typeof entry.createdAt === "number";
}

/** Read the stored subscriptions. An absent, malformed or hand-edited value
 * reads as an empty list and every entry that does not validate is dropped —
 * the same rule as the connection registry: one broken record must not stop
 * the others from being sent to, and a record that cannot be addressed is
 * useless. Duplicates (the same endpoint written twice) keep the newest, and
 * the list is capped to the newest {@link PUSH_MAX_SUBSCRIPTIONS}. */
export function parsePushSubscriptions(
  raw: string | undefined | null,
): PushSubscriptionRecord[] {
  const parsed = safeJsonParse<unknown>(raw);
  if (!Array.isArray(parsed)) return [];
  const byEndpoint = new Map<string, PushSubscriptionRecord>();
  for (const entry of parsed) {
    if (!isSubscription(entry)) continue;
    const known = byEndpoint.get(entry.endpoint);
    if (known === undefined || known.createdAt <= entry.createdAt) {
      byEndpoint.set(entry.endpoint, {
        endpoint: entry.endpoint,
        keys: { p256dh: entry.keys.p256dh, auth: entry.keys.auth },
        createdAt: entry.createdAt,
      });
    }
  }
  const records = [...byEndpoint.values()].sort((a, b) =>
    a.createdAt - b.createdAt
  );
  return records.slice(-PUSH_MAX_SUBSCRIPTIONS);
}

/** Serialize the subscriptions for the settings store. */
export function serializePushSubscriptions(
  records: readonly PushSubscriptionRecord[],
): string {
  return JSON.stringify(records);
}
