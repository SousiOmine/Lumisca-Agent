import { assert, assertEquals } from "@std/assert";
import { fauxProvider, LumiscaCore } from "@lumisca/core";
import { toBase64Url } from "@lumisca/core/shared";
import { createApp } from "./app.ts";

const HOST = { host: "127.0.0.1:8000" };

/** A subscription as a browser posts it: a real P-256 point and a secret, so
 * the store's validation is exercised rather than bypassed. */
async function subscription(endpoint = "https://push.example/one") {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  return {
    endpoint,
    keys: {
      p256dh: toBase64Url(
        new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)),
      ),
      auth: toBase64Url(new Uint8Array(16).fill(1)),
    },
  };
}

async function request(
  core: LumiscaCore,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const app = createApp(core);
  return await app.fetch(
    new Request(`http://127.0.0.1:8000${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...HOST,
        ...init?.headers,
      },
    }),
  );
}

Deno.test("the VAPID public key is served and created on first ask", async () => {
  const core = LumiscaCore.forTesting([fauxProvider().provider]);
  try {
    const response = await request(core, "/api/notify/key");
    assertEquals(response.status, 200);
    const body = await response.json() as { publicKey: string };
    // An uncompressed P-256 point is 87 base64url characters.
    assertEquals(body.publicKey.length, 87);
    // Asking again answers the same key: replacing it would silently orphan
    // every subscription made with the first one.
    const again = await request(core, "/api/notify/key");
    assertEquals(
      (await again.json() as { publicKey: string }).publicKey,
      body.publicKey,
    );
  } finally {
    core.close();
  }
});

Deno.test("a subscription is stored, counted and removable", async () => {
  const core = LumiscaCore.forTesting([fauxProvider().provider]);
  try {
    const input = await subscription();
    const added = await request(core, "/api/notify/subscriptions", {
      method: "POST",
      body: JSON.stringify(input),
    });
    assertEquals(added.status, 200);
    assertEquals(core.listPushSubscriptions().length, 1);

    // The count is what the settings page draws; the keys never leave.
    const listed = await request(core, "/api/notify/subscriptions");
    assertEquals(await listed.json(), { count: 1 });

    const removed = await request(core, "/api/notify/subscriptions", {
      method: "DELETE",
      body: JSON.stringify({ endpoint: input.endpoint }),
    });
    assertEquals(await removed.json(), { ok: true, removed: true });
    assertEquals(core.listPushSubscriptions(), []);

    // Removing an endpoint that is not there is the state the caller wanted.
    const again = await request(core, "/api/notify/subscriptions", {
      method: "DELETE",
      body: JSON.stringify({ endpoint: input.endpoint }),
    });
    assertEquals(await again.json(), { ok: true, removed: false });
  } finally {
    core.close();
  }
});

Deno.test("a subscription that cannot be sent to is refused with 400", async () => {
  const core = LumiscaCore.forTesting([fauxProvider().provider]);
  try {
    const valid = await subscription();
    const bodies: unknown[] = [
      { ...valid, endpoint: "http://push.example/one" },
      { endpoint: valid.endpoint },
      { ...valid, keys: { p256dh: valid.keys.p256dh } },
      { ...valid, endpoint: "" },
      "not-an-object",
    ];
    for (const body of bodies) {
      const response = await request(core, "/api/notify/subscriptions", {
        method: "POST",
        body: JSON.stringify(body),
      });
      assertEquals(response.status, 400, JSON.stringify(body));
    }
    assertEquals(core.listPushSubscriptions(), []);
  } finally {
    core.close();
  }
});

Deno.test("the notification surface is behind the token guard", async () => {
  // A subscription endpoint is a capability to wake a device: a page that can
  // write one without the token could add itself to every later send.
  const core = LumiscaCore.forTesting([fauxProvider().provider]);
  const app = createApp(core, { token: "secret-token" });
  try {
    const response = await app.fetch(
      new Request("http://127.0.0.1:8000/api/notify/key", { headers: HOST }),
    );
    assertEquals(response.status, 401);
    assert(
      (await response.text()).includes("Unauthorized"),
      "the guard refuses without a token",
    );
  } finally {
    core.close();
  }
});

Deno.test("a malformed body is a 400, not a 500", async () => {
  const core = LumiscaCore.forTesting([fauxProvider().provider]);
  try {
    const response = await request(core, "/api/notify/subscriptions", {
      method: "POST",
      body: "{",
    });
    assertEquals(response.status, 400);
  } finally {
    core.close();
  }
});
