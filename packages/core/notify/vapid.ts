/**
 * The VAPID key pair every Web Push message is signed with (RFC 8292).
 *
 * One pair per installation, stored in the settings file. The browser keeps
 * the public half in its subscription (it is the `applicationServerKey` it was
 * subscribed with) and checks that each incoming message was signed by it, so
 * the pair must not change under a live subscription: a replaced key leaves
 * every stored subscription subscribed to nothing, and the browser silently
 * drops the messages. It is therefore created once and then read.
 *
 * Creation is lazy — at the first request for the public key, which only a
 * client about to subscribe makes — rather than at startup: a user who never
 * enables notifications never gets a secret written for them.
 */

import type { SettingsRepo } from "../settings/repo.ts";
import { fromBase64Url, toBase64Url } from "../shared/push.ts";
import { PUSH_VAPID_KEY } from "../shared/settings-keys.ts";

/** The curve of a VAPID key (`prime256v1` = P-256, what ES256 signs with). */
const CURVE = "P-256";

/** The `sub` VAPID claims carry: a contact address the push service may use
 * to reach whoever operates this installation about the traffic. It is not
 * checked by every service, but Apple's requires it to be a `mailto:` or an
 * https URL, so the value is a reserved documentation domain rather than a
 * real mailbox nobody reads. */
const VAPID_SUBJECT = "mailto:lumisca@example.invalid";

/** What the server needs to sign a push request: the private key, and the
 * public half in the uncompressed form the `Authorization` header carries. */
export interface VapidKeys {
  privateKey: CryptoKey;
  /** base64url of the 65-byte uncompressed point (`k=…` in the header). */
  publicKey: string;
  subject: string;
}

/** Read the stored pair, creating it when absent. Throws when the stored
 * value exists but cannot be used as a P-256 signing key: silently replacing
 * it would invalidate every subscription that was made with the old one, and
 * the operator has to know why their notifications stopped. */
export async function loadVapidKeys(
  settings: SettingsRepo,
): Promise<VapidKeys> {
  const stored = settings.get(PUSH_VAPID_KEY);
  if (stored !== undefined && stored.trim() !== "") {
    return keysFromStoredJson(stored);
  }
  const created = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: CURVE },
    true,
    ["sign", "verify"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", created.privateKey);
  const publicKey = toBase64Url(
    new Uint8Array(await crypto.subtle.exportKey("raw", created.publicKey)),
  );
  settings.set(PUSH_VAPID_KEY, JSON.stringify({ privateJwk: jwk, publicKey }));
  return { privateKey: created.privateKey, publicKey, subject: VAPID_SUBJECT };
}

/** Read a stored pair. Exported so a test can drive the rejection without
 * writing a file. */
export async function keysFromStoredJson(json: string): Promise<VapidKeys> {
  let parsed: { privateJwk?: JsonWebKey; publicKey?: unknown };
  try {
    parsed = JSON.parse(json) as typeof parsed;
  } catch {
    throw new Error("the stored VAPID key pair is not JSON");
  }
  if (
    typeof parsed?.publicKey !== "string" ||
    parsed.privateJwk === undefined
  ) {
    throw new Error("the stored VAPID key pair is incomplete");
  }
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    parsed.privateJwk,
    { name: "ECDSA", namedCurve: CURVE },
    false,
    ["sign"],
  );
  // The public half is derived from the private one instead of trusted: a
  // hand edit that changes only `publicKey` would otherwise advertise a key
  // that cannot verify this server's signatures, and every subscription made
  // from it would drop the messages in silence. A JWK carries the point's
  // coordinates, which is where the uncompressed form comes from.
  const derived = toBase64Url(
    uncompressedPoint(parsed.privateJwk.x, parsed.privateJwk.y),
  );
  if (derived !== parsed.publicKey) {
    throw new Error("the stored VAPID key pair does not match its public half");
  }
  return { privateKey, publicKey: parsed.publicKey, subject: VAPID_SUBJECT };
}

/** `0x04 || X || Y` from a JWK's coordinates: the SEC1 spelling of a P-256
 * public key, which is what `applicationServerKey` and the `k=` parameter
 * both want. */
function uncompressedPoint(
  x: string | undefined,
  y: string | undefined,
): Uint8Array<ArrayBuffer> {
  if (x === undefined || y === undefined) {
    throw new Error("the stored VAPID key pair has no public coordinates");
  }
  const xBytes = fromBase64Url(x);
  const yBytes = fromBase64Url(y);
  if (xBytes.length !== 32 || yBytes.length !== 32) {
    throw new Error("the stored VAPID key pair is not a P-256 key");
  }
  const point = new Uint8Array(65);
  point[0] = 0x04;
  point.set(xBytes, 1);
  point.set(yBytes, 33);
  return point;
}

/** The bytes of a subscription's `p256dh`, for the ECDH exchange. Throws when
 * the value is not an uncompressed P-256 point, which is a subscription this
 * server must not try to send to. */
export function subscriptionPublicKey(p256dh: string): Uint8Array<ArrayBuffer> {
  const bytes = fromBase64Url(p256dh);
  if (bytes.length !== 65 || bytes[0] !== 0x04) {
    throw new Error("p256dh is not an uncompressed P-256 point");
  }
  return bytes;
}

/** The bytes of a subscription's `auth` (16 in practice). Throws when the
 * value cannot be a shared secret. */
export function subscriptionAuthSecret(auth: string): Uint8Array<ArrayBuffer> {
  const bytes = fromBase64Url(auth);
  if (bytes.length === 0) throw new Error("auth is empty");
  return bytes;
}
