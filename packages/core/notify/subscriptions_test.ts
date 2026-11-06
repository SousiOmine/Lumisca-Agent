import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  fromBase64Url,
  parsePushSubscriptions,
  type PushSubscriptionRecord,
  serializePushSubscriptions,
  toBase64Url,
} from "../shared/push.ts";
import { createInMemorySettingsRepo } from "../settings/repo.ts";
import { PushSubscriptions } from "./subscriptions.ts";
import { keysFromStoredJson, loadVapidKeys } from "./vapid.ts";
import { PUSH_SUBSCRIPTIONS_KEY } from "../shared/settings-keys.ts";

/** A P-256 point and a secret, in the shape a browser reports them. */
async function subscriber(): Promise<{ p256dh: string; auth: string }> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const raw = new Uint8Array(
    await crypto.subtle.exportKey("raw", pair.publicKey),
  );
  return {
    p256dh: toBase64Url(raw),
    auth: toBase64Url(new Uint8Array(16).fill(7)),
  };
}

function record(
  endpoint: string,
  overrides: Partial<PushSubscriptionRecord> = {},
): PushSubscriptionRecord {
  return {
    endpoint,
    keys: { p256dh: "p256dh", auth: "auth" },
    createdAt: 1,
    ...overrides,
  };
}

Deno.test("base64url round-trips and tolerates a missing pad", () => {
  const bytes = new Uint8Array([0, 1, 250, 251, 252, 255, 62, 63]);
  const encoded = toBase64Url(bytes);
  assert(!encoded.includes("="), "no padding in the url-safe form");
  assertEquals(fromBase64Url(encoded), bytes);
  // A browser may hand back a padded standard base64 value; the decoder reads
  // it as the same bytes rather than failing the subscription.
  assertEquals(fromBase64Url("AQID"), new Uint8Array([1, 2, 3]));
});

Deno.test("a stored subscription list drops what cannot be addressed", () => {
  const parsed = parsePushSubscriptions(JSON.stringify([
    record("https://push.example/1"),
    // http is not a push endpoint: every push service is https.
    record("http://push.example/2"),
    // A missing key cannot be encrypted for.
    { endpoint: "https://push.example/3", keys: { auth: "a" }, createdAt: 1 },
    record("https://push.example/4"),
  ]));
  assertEquals(parsed.map((entry) => entry.endpoint), [
    "https://push.example/1",
    "https://push.example/4",
  ]);
  assertEquals(parsePushSubscriptions("not json"), []);
  assertEquals(parsePushSubscriptions(undefined), []);
});

Deno.test("the same endpoint stored twice reads once, newest first", () => {
  const parsed = parsePushSubscriptions(
    serializePushSubscriptions([
      record("https://push.example/a", { createdAt: 1 }),
      record("https://push.example/b", { createdAt: 3 }),
      record("https://push.example/a", { createdAt: 2 }),
    ]),
  );
  assertEquals(parsed.map((entry) => entry.endpoint), [
    "https://push.example/a",
    "https://push.example/b",
  ]);
  // The newest copy wins, not the first one read.
  assertEquals(parsed[0]!.createdAt, 2);
});

Deno.test("subscribing twice replaces instead of duplicating", async () => {
  const settings = createInMemorySettingsRepo();
  const service = new PushSubscriptions(settings);
  const keys = await subscriber();
  service.add({ endpoint: "https://push.example/1", keys });
  service.add({ endpoint: "https://push.example/1", keys: await subscriber() });
  assertEquals(service.list().length, 1);
});

Deno.test("removing an endpoint is idempotent and reports the first", () => {
  const settings = createInMemorySettingsRepo();
  const service = new PushSubscriptions(settings);
  service.add({
    endpoint: "https://push.example/1",
    keys: { p256dh: "p", auth: "a" },
  });
  assertEquals(service.remove("https://push.example/1"), true);
  assertEquals(service.remove("https://push.example/1"), false);
  assertEquals(settings.get(PUSH_SUBSCRIPTIONS_KEY), "[]");
});

Deno.test("a bad subscription is refused, not stored", () => {
  const service = new PushSubscriptions(createInMemorySettingsRepo());
  for (
    const input of [
      { endpoint: "http://push.example/1", keys: { p256dh: "p", auth: "a" } },
      { endpoint: "https://push.example/1", keys: { p256dh: "", auth: "a" } },
      { endpoint: "https://push.example/1", keys: { p256dh: "p", auth: "" } },
    ]
  ) {
    let refused = false;
    try {
      service.add(input);
    } catch {
      refused = true;
    }
    assert(refused, `refused: ${JSON.stringify(input)}`);
    assertEquals(service.list(), []);
  }
});

Deno.test("the VAPID pair is created once and then reused", async () => {
  const settings = createInMemorySettingsRepo();
  const first = await loadVapidKeys(settings);
  assertEquals(first.publicKey.length > 80, true);
  const second = await loadVapidKeys(settings);
  assertEquals(second.publicKey, first.publicKey);
});

Deno.test("a VAPID pair whose halves disagree is refused", async () => {
  // Replacing the pair silently would leave every subscription subscribed to a
  // key the browser no longer sees, and the messages would vanish unseen.
  const settings = createInMemorySettingsRepo();
  const created = await loadVapidKeys(settings);
  const other = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign"],
  );
  const otherPublic = toBase64Url(
    new Uint8Array(await crypto.subtle.exportKey("raw", other.publicKey)),
  );
  const mismatched = JSON.stringify({
    privateJwk: await crypto.subtle.exportKey("jwk", other.privateKey),
    publicKey: created.publicKey,
  });
  await assertRejects(
    () => keysFromStoredJson(mismatched),
    Error,
    "public half",
  );
  assert(otherPublic !== created.publicKey);
});

Deno.test("a corrupt VAPID record fails instead of rotating the key", async () => {
  const settings = createInMemorySettingsRepo();
  settings.set("push_vapid", "{not json");
  await assertRejects(() => loadVapidKeys(settings));
});
