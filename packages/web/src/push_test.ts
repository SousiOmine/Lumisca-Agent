import { assertEquals } from "@std/assert";
import { fromBase64Url, toBase64Url } from "@lumisca/core/shared";
import { canUsePush } from "./push.ts";

/** The page's codec has to agree with the server's (`shared/push.ts`) and
 * with the worker's copy (public/sw.js, which cannot import it): a key read
 * with one spelling and compared with another is a subscription that silently
 * never verifies. */
Deno.test("the page encodes keys the way the server writes them", () => {
  const bytes = new Uint8Array([4, 0, 255, 62, 63, 1, 2, 3]);
  const encoded = toBase64Url(bytes);
  assertEquals(encoded.includes("="), false);
  assertEquals(encoded.includes("+"), false);
  assertEquals(encoded.includes("/"), false);
  assertEquals(fromBase64Url(encoded), bytes);
});

Deno.test("a P-256 point survives the round trip a subscription makes", async () => {
  // The exact shape `applicationServerKey` receives: 65 bytes, byte 0 = 0x04.
  const pair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const raw = new Uint8Array(
    await crypto.subtle.exportKey("raw", pair.publicKey),
  );
  const decoded = fromBase64Url(toBase64Url(raw));
  assertEquals(decoded.length, 65);
  assertEquals(decoded[0], 0x04);
  assertEquals(decoded, raw);
});

Deno.test("Web Push needs a secure origin a worker is registered on", () => {
  // The same rule that decides whether the worker is registered at all
  // (pwa.ts): https outside the desktop shell. A phone on http, or the
  // desktop's loopback page, has no push channel — the settings row says so
  // instead of offering a switch that cannot work.
  assertEquals(
    canUsePush({ protocol: "https:", shell: false, api: true }),
    true,
  );
  assertEquals(
    canUsePush({ protocol: "http:", shell: false, api: true }),
    false,
  );
  assertEquals(
    canUsePush({ protocol: "https:", shell: true, api: true }),
    false,
  );
});

Deno.test("a browser without the Push API is unsupported on https", () => {
  // Safari on iOS before 16.4, and an ordinary tab there even after it: the
  // origin is fine, the API is not.
  assertEquals(
    canUsePush({ protocol: "https:", shell: false, api: false }),
    false,
  );
});
