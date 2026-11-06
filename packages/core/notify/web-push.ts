/**
 * Encrypting and delivering one Web Push message (RFC 8291 over the
 * aes128gcm content encoding, authorized with VAPID per RFC 8292).
 *
 * Everything here is WebCrypto: ECDH for the shared secret, HKDF for the two
 * keys, AES-GCM for the record and ECDSA for the token. No dependency is
 * added for it — the whole protocol is three `subtle` calls and a header.
 *
 * The one thing worth reading twice is why the plaintext carries a delimiter:
 * aes128gcm pads a record by appending bytes and marking the last one with
 * 0x02, and a browser strips everything from that marker. Sending the JSON
 * without the marker therefore arrives as a record the browser cannot
 * terminate, and the message is dropped without an error anyone sees.
 */
import type { VapidKeys } from "./vapid.ts";
import { toBase64Url } from "../shared/push.ts";
import type { PushSubscriptionRecord } from "../shared/push.ts";
import { subscriptionAuthSecret, subscriptionPublicKey } from "./vapid.ts";

/** Record size of the body (RFC 8188 `rs`). The browser allocates its buffer
 * from the header, so a larger value than the body is normal; this is the size
 * Chrome, Firefox and Apple's services all accept. */
const RECORD_SIZE = 4096;

/** Longest a message may sit in the push service while the device is offline
 * (seconds). A day: a notification about a run that finished yesterday is
 * still worth showing, and the service drops it after this rather than
 * delivering it a week later. */
const PUSH_TTL_SECONDS = 86_400;

/** Lifetime of the VAPID token. Push services reject one that is too far in
 * the future, and twelve hours is under every documented limit while leaving
 * room for a clock that is a little ahead. */
const VAPID_TOKEN_LIFETIME_SECONDS = 12 * 60 * 60;

/** What a `push` event's data carries. The service worker reads the same
 * shape (public/sw.js reads `{ title, body, tag }`). */
export interface PushMessage {
  title: string;
  body: string;
  /** Collapses messages: a notification with the same tag replaces the one
   * already shown, so a session's messages do not stack up. */
  tag: string;
}

/** How urgent the push service should treat the message. `high` also wakes a
 * sleeping device (the agent is waiting for an answer, so the user needs to
 * see it now). */
export type PushUrgency = "high" | "normal";

/** What the push service answered, as far as this server acts on it. */
export type PushResult =
  /** Accepted for delivery. */
  | { kind: "sent"; status: number }
  /** The subscription no longer exists (404 / 410): the device unsubscribed,
   * the browser was reinstalled, or the endpoint expired. It must be deleted,
   * or every later message pays for the same failure. */
  | { kind: "gone"; status: number }
  /** Anything else: a transient refusal or an error on the account (401, 413,
   * 429, 5xx). The subscription stays; the next message tries again. */
  | { kind: "failed"; status: number; detail: string };

/** Encrypt `message` for one subscription. The result is the complete request
 * body, header block included. */
export async function encryptPushPayload(
  keys: { p256dh: string; auth: string },
  message: PushMessage,
): Promise<Uint8Array<ArrayBuffer>> {
  const userPublic = subscriptionPublicKey(keys.p256dh);
  const authSecret = subscriptionAuthSecret(keys.auth);
  const local = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const localPublic = new Uint8Array(
    await crypto.subtle.exportKey("raw", local.publicKey),
  );
  const shared = await crypto.subtle.deriveBits(
    {
      name: "ECDH",
      public: await crypto.subtle.importKey(
        "raw",
        userPublic,
        { name: "ECDH", namedCurve: "P-256" },
        false,
        [],
      ),
    },
    local.privateKey,
    256,
  );

  // IKM: the ECDH secret bound to both public keys and to the client's
  // secret, so a message cannot be replayed onto another subscription.
  const ikm = await hkdf(
    authSecret,
    new Uint8Array(shared),
    concat(
      new TextEncoder().encode("WebPush: info\u0000"),
      userPublic,
      localPublic,
    ),
    32,
  );
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const contentKey = await hkdf(
    salt,
    ikm,
    new TextEncoder().encode("Content-Encoding: aes128gcm\u0000"),
    16,
  );
  const nonce = await hkdf(
    salt,
    ikm,
    new TextEncoder().encode("Content-Encoding: nonce\u0000"),
    12,
  );

  const plaintext = new TextEncoder().encode(JSON.stringify(message));
  // The last record of a message ends with the 0x02 delimiter (RFC 8188 §2);
  // without it the browser has no way to know the record is complete.
  const record = concat(plaintext, Uint8Array.of(0x02));
  if (record.length + 16 > RECORD_SIZE) {
    // 16 is the AES-GCM tag. A larger message is a caller's bug: the title
    // and body of a notification are nowhere near this.
    throw new Error("the push message exceeds one record");
  }
  const key = await crypto.subtle.importKey(
    "raw",
    contentKey,
    "AES-GCM",
    false,
    [
      "encrypt",
    ],
  );
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, record),
  );

  const header = new Uint8Array(16 + 4 + 1 + localPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = localPublic.length;
  header.set(localPublic, 21);
  return concat(header, ciphertext);
}

/** HKDF-SHA256 with the given salt and info. */
async function hkdf(
  salt: Uint8Array<ArrayBuffer>,
  ikm: Uint8Array<ArrayBuffer>,
  info: Uint8Array<ArrayBuffer>,
  length: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const base = await crypto.subtle.importKey("raw", ikm, "HKDF", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info },
    base,
    length * 8,
  );
  return new Uint8Array(bits);
}

function concat(
  ...parts: Uint8Array<ArrayBufferLike>[]
): Uint8Array<ArrayBuffer> {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** The `Authorization` header value for one request: an ES256 token whose
 * `aud` is the endpoint's origin, plus the public half of the signing key. */
export async function buildVapidAuth(
  endpoint: string,
  keys: VapidKeys,
  now: number = Date.now(),
): Promise<string> {
  const origin = new URL(endpoint).origin;
  const header = toBase64Url(
    new TextEncoder().encode(JSON.stringify({ typ: "JWT", alg: "ES256" })),
  );
  const claims = toBase64Url(
    new TextEncoder().encode(JSON.stringify({
      aud: origin,
      exp: Math.floor(now / 1000) + VAPID_TOKEN_LIFETIME_SECONDS,
      sub: keys.subject,
    })),
  );
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    keys.privateKey,
    new TextEncoder().encode(`${header}.${claims}`),
  );
  // WebCrypto already answers JWS's raw r||s form, which is what ES256 is.
  return `vapid t=${header}.${claims}.${
    toBase64Url(new Uint8Array(signature))
  }, k=${keys.publicKey}`;
}

/** Send one message to one subscription. Failures are classified, never
 * thrown: the caller decides what to keep, and a notification is best-effort
 * by nature. */
export async function sendPush(
  fetchImpl: typeof fetch,
  keys: VapidKeys,
  subscription: PushSubscriptionRecord,
  message: PushMessage,
  options: { urgency?: PushUrgency; timeoutMs?: number } = {},
): Promise<PushResult> {
  const body = await encryptPushPayload(subscription.keys, message);
  const authorization = await buildVapidAuth(subscription.endpoint, keys);
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? 10_000,
  );
  try {
    const response = await fetchImpl(subscription.endpoint, {
      method: "POST",
      headers: {
        "authorization": authorization,
        "content-encoding": "aes128gcm",
        "content-type": "application/octet-stream",
        "ttl": String(PUSH_TTL_SECONDS),
        "urgency": options.urgency ?? "normal",
      },
      body,
      signal: controller.signal,
    });
    if (response.ok) return { kind: "sent", status: response.status };
    if (response.status === 404 || response.status === 410) {
      return { kind: "gone", status: response.status };
    }
    const detail = (await response.text().catch(() => "")).slice(0, 200);
    return { kind: "failed", status: response.status, detail };
  } catch (error) {
    // A transport failure (offline, DNS, timeout) says nothing about whether
    // the subscription exists: it is a failed attempt, not a gone one.
    return {
      kind: "failed",
      status: 0,
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Decrypt a body produced by {@link encryptPushPayload} the way a browser
 * does. Only the tests need this; it is exported beside the encryptor so the
 * two cannot drift into "each one's own idea of the format". */
export async function decryptPushPayload(
  keys: { p256dh: string; auth: string },
  privateKey: CryptoKey,
  body: Uint8Array,
): Promise<PushMessage> {
  const salt = body.slice(0, 16);
  const idLength = body[20]!;
  const localPublic = body.slice(21, 21 + idLength);
  const ciphertext = body.slice(21 + idLength);
  const userPublic = subscriptionPublicKey(keys.p256dh);
  const shared = await crypto.subtle.deriveBits(
    {
      name: "ECDH",
      public: await crypto.subtle.importKey(
        "raw",
        localPublic,
        { name: "ECDH", namedCurve: "P-256" },
        false,
        [],
      ),
    },
    privateKey,
    256,
  );
  const ikm = await hkdf(
    subscriptionAuthSecret(keys.auth),
    new Uint8Array(shared),
    concat(
      new TextEncoder().encode("WebPush: info\u0000"),
      userPublic,
      localPublic,
    ),
    32,
  );
  const contentKey = await hkdf(
    salt,
    ikm,
    new TextEncoder().encode("Content-Encoding: aes128gcm\u0000"),
    16,
  );
  const nonce = await hkdf(
    salt,
    ikm,
    new TextEncoder().encode("Content-Encoding: nonce\u0000"),
    12,
  );
  const key = await crypto.subtle.importKey(
    "raw",
    contentKey,
    "AES-GCM",
    false,
    [
      "decrypt",
    ],
  );
  const record = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce },
      key,
      ciphertext,
    ),
  );
  // The record is `data || 0x00 padding… || delimiter`, where the delimiter is
  // 0x02 on the last record of a message. Padding sits before it, so the walk
  // starts from the end: the delimiter, then anything zero before the JSON.
  let end = record.length;
  if (record[end - 1] === 0x01 || record[end - 1] === 0x02) end--;
  while (end > 0 && record[end - 1] === 0x00) end--;
  return JSON.parse(
    new TextDecoder().decode(record.slice(0, end)),
  ) as PushMessage;
}
