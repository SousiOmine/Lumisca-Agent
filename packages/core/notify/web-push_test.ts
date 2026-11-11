import { assert, assertEquals, assertRejects } from "@std/assert";
import { createInMemorySettingsRepo } from "../settings/repo.ts";
import { type PushSubscriptionRecord, toBase64Url } from "../shared/push.ts";
import { loadVapidKeys } from "./vapid.ts";
import {
  buildVapidAuth,
  decryptPushPayload,
  encryptPushPayload,
  sendPush,
} from "./web-push.ts";

/** A browser's side of the channel: the key pair it subscribed with, and the
 * secret the service worker holds. */
async function subscription(): Promise<{
  record: PushSubscriptionRecord;
  privateKey: CryptoKey;
}> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const p256dh = toBase64Url(
    new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)),
  );
  return {
    record: {
      endpoint: "https://push.example/abc",
      keys: { p256dh, auth: toBase64Url(new Uint8Array(16).fill(3)) },
      createdAt: 0,
    },
    privateKey: pair.privateKey,
  };
}

Deno.test("a push body decrypts to the message the browser shows", async () => {
  // The format is only right if a browser can read it, and the browser's side
  // is exactly this: ECDH against the sender's ephemeral key, the two HKDF
  // steps, then AES-GCM. Round-tripping through the same code would prove
  // nothing about the wire format; decryptPushPayload does the client's steps
  // from the body alone, as a service worker has to.
  const { record, privateKey } = await subscription();
  const body = await encryptPushPayload(record.keys, {
    title: "Lumisca",
    body: "作業が完了しました",
    tag: "session:s1",
  });
  const decoded = await decryptPushPayload(record.keys, privateKey, body);
  assertEquals(decoded, {
    title: "Lumisca",
    body: "作業が完了しました",
    tag: "session:s1",
  });
});

Deno.test("the encrypted header carries the salt, record size and key", async () => {
  const { record } = await subscription();
  const body = await encryptPushPayload(record.keys, {
    title: "T",
    body: "B",
    tag: "",
  });
  // 16-byte salt, 4-byte record size, 1-byte key length, 65-byte P-256 point
  // (RFC 8188 §2.1), then one ciphertext block.
  assertEquals(new DataView(body.buffer).getUint32(16), 4096);
  assertEquals(body[20], 65);
  assertEquals(body[21], 0x04);
  assert(body.length > 21 + 65);
});

Deno.test("two messages to one subscription differ (fresh salt and key)", async () => {
  const { record } = await subscription();
  const message = { title: "T", body: "B", tag: "t" };
  const first = await encryptPushPayload(record.keys, message);
  const second = await encryptPushPayload(record.keys, message);
  assert(first.every((byte, index) => byte === second[index]) === false);
});

Deno.test("a subscription that is not a P-256 point is refused", async () => {
  await assertRejects(() =>
    encryptPushPayload(
      { p256dh: toBase64Url(new Uint8Array(10)), auth: "AAAA" },
      { title: "T", body: "B", tag: "" },
    ),
  );
});

Deno.test("the VAPID header is an ES256 token scoped to the endpoint", async () => {
  const keys = await loadVapidKeys(createInMemorySettingsRepo());
  const header = await buildVapidAuth("https://push.example/abc/def", keys);
  const match = /^vapid t=([^,]+), k=(.+)$/.exec(header);
  assert(match !== null, header);
  const [, token, publicKey] = match;
  assertEquals(publicKey, keys.publicKey);
  const [encodedHeader, encodedClaims, encodedSignature] = token!.split(".");
  assertEquals(
    JSON.parse(atob(encodedHeader!.replaceAll("-", "+").replaceAll("_", "/"))),
    { typ: "JWT", alg: "ES256" },
  );
  const claims = JSON.parse(
    atob(encodedClaims!.replaceAll("-", "+").replaceAll("_", "/")),
  ) as { aud: string; exp: number; sub: string };
  // `aud` names the service, not the subscription: the endpoint includes the
  // subscription id, and a token scoped to it is rejected as the wrong origin.
  assertEquals(claims.aud, "https://push.example");
  assertEquals(claims.exp > Date.now() / 1000, true);
  assert(claims.sub.startsWith("mailto:") || claims.sub.startsWith("https:"));
  // The signature verifies against the advertised public key: that check is
  // what makes the header usable.
  const raw = new Uint8Array(
    atob(publicKey!.replaceAll("-", "+").replaceAll("_", "/"))
      .split("")
      .map((c) => c.charCodeAt(0)),
  );
  const verifyKey = await crypto.subtle.importKey(
    "raw",
    raw,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const verified = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    verifyKey,
    new Uint8Array(
      atob(encodedSignature!.replaceAll("-", "+").replaceAll("_", "/"))
        .split("")
        .map((c) => c.charCodeAt(0)),
    ),
    new TextEncoder().encode(`${encodedHeader}.${encodedClaims}`),
  );
  assertEquals(verified, true);
});

Deno.test("sendPush posts an encrypted body and reports what happened", async () => {
  const { record, privateKey } = await subscription();
  const keys = await loadVapidKeys(createInMemorySettingsRepo());
  let seen: { url: string; init: RequestInit } | undefined;
  const fake: typeof fetch = (input, init) => {
    seen = { url: String(input), init: init ?? {} };
    return Promise.resolve(new Response(null, { status: 201 }));
  };
  const result = await sendPush(
    fake,
    keys,
    record,
    {
      title: "Lumisca",
      body: "done",
      tag: "session:s1",
    },
    { urgency: "high" },
  );
  assertEquals(result, { kind: "sent", status: 201 });
  assertEquals(seen?.url, record.endpoint);
  const headers = seen!.init.headers as Record<string, string>;
  assertEquals(headers["content-encoding"], "aes128gcm");
  assertEquals(headers["urgency"], "high");
  assert(headers["authorization"]?.startsWith("vapid t=") === true);
  const decoded = await decryptPushPayload(
    record.keys,
    privateKey,
    seen!.init.body as Uint8Array,
  );
  assertEquals(decoded.body, "done");
});

Deno.test("a gone subscription is reported as gone, not as an error", async () => {
  const { record } = await subscription();
  const keys = await loadVapidKeys(createInMemorySettingsRepo());
  for (const status of [404, 410]) {
    const result = await sendPush(
      () => Promise.resolve(new Response(null, { status })),
      keys,
      record,
      { title: "T", body: "B", tag: "" },
    );
    assertEquals(result, { kind: "gone", status });
  }
});

Deno.test("a transient refusal keeps the subscription", async () => {
  const { record } = await subscription();
  const keys = await loadVapidKeys(createInMemorySettingsRepo());
  const result = await sendPush(
    () => Promise.resolve(new Response("busy", { status: 429 })),
    keys,
    record,
    { title: "T", body: "B", tag: "" },
  );
  assertEquals(result.kind, "failed");
  // A transport failure says nothing about the subscription either.
  const offline = await sendPush(
    () => Promise.reject(new TypeError("Failed to fetch")),
    keys,
    record,
    { title: "T", body: "B", tag: "" },
  );
  assertEquals(offline, {
    kind: "failed",
    status: 0,
    detail: "Failed to fetch",
  });
});
