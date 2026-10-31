import { assert, assertEquals } from "@std/assert";
import { assertEquals as assertSame } from "@std/assert";
import {
  AGENT_ICON_MIME_BY_EXTENSION,
  agentAvatarHue,
  agentIconExtensionOfMimeType,
  agentIconMimeType,
  agentInitial,
  MAX_AGENT_ICON_BYTES,
} from "./agent-avatar.ts";

/**
 * The agent avatar: the initial an agent without a picture shows, the colour
 * it shows it on, and the icon limits the upload route and the store share.
 *
 * The colour is derived from the id, so what matters is that it is stable and
 * spread out — never which hue a particular id gets.
 */

Deno.test("agentInitial: Latin letters are uppercased, other scripts kept", () => {
  assertEquals(agentInitial("aide"), "A");
  assertEquals(agentInitial("  researcher"), "R");
  // A non-Latin initial is left as written: uppercasing kana or CJK does
  // nothing, and case-folding it by hand would be wrong.
  assertEquals(agentInitial("あい"), "あ");
  assertEquals(agentInitial("研"), "研");
  // Already uppercase.
  assertEquals(agentInitial("Zeta"), "Z");
  // A digit or symbol is its own initial.
  assertEquals(agentInitial("3rd assistant"), "3");
  assertEquals(agentInitial("_private"), "_");
});

Deno.test("agentInitial: one code point, never half a surrogate pair", () => {
  // An emoji name must not be drawn as a replacement box: taking one UTF-16
  // unit would leave the unpaired high surrogate.
  assertEquals(agentInitial("🤖 helper"), "🤖");
  assertEquals([...agentInitial("🤖 helper")].length, 1);
});

Deno.test("agentInitial: an empty name answers a placeholder", () => {
  // Names cannot be empty (normalizeAgentInput refuses them); this is the
  // shape a row falls back to, not a state a user can reach.
  assertEquals(agentInitial(""), "?");
  assertEquals(agentInitial("   "), "?");
});

Deno.test("agentAvatarHue: the same id always gets the same hue", () => {
  const id = "6f0c1f9e-2a44-4f4d-9f0e-8a3b7c5d1e2f";
  const first = agentAvatarHue(id);
  assertEquals(agentAvatarHue(id), first);
  assertEquals(first, first); // trivially, but read as "computed once"
});

Deno.test("agentAvatarHue: hues are in range and spread over ids", () => {
  const hues: number[] = [];
  for (let i = 0; i < 200; i++) {
    const hue = agentAvatarHue(`agent-${i}`);
    assert(Number.isInteger(hue), `not an integer: ${hue}`);
    assert(hue >= 0 && hue < 360, `out of range: ${hue}`);
    hues.push(hue);
  }
  // A constant function would pass the range check; a hash must not cluster
  // into one corner of the wheel.
  const buckets = new Set(hues.map((hue) => Math.floor(hue / 30)));
  assert(buckets.size >= 8, `only ${buckets.size} of 12 hue buckets used`);
  // Two ids that differ in one character ("agent-1" / "agent-2") are the pair
  // a list actually has next to each other, so the spread is measured on
  // them, not only on generated UUIDs.
  const distinct = new Set(hues).size;
  assert(distinct >= 100, `only ${distinct} distinct hues in 200 ids`);
});

Deno.test("agentAvatarHue: different ids usually differ", () => {
  // Two agents created a millisecond apart must not look identical. The hash
  // is not injective (360 buckets), so this is a spread check, not a promise.
  assert(agentAvatarHue("a") !== agentAvatarHue("b"));
  assert(agentAvatarHue("abc") !== agentAvatarHue("abd"));
});

Deno.test("agentIconMimeType: only raster formats, by extension", () => {
  assertEquals(agentIconMimeType(".png"), "image/png");
  assertEquals(agentIconMimeType(".PNG"), "image/png");
  assertEquals(agentIconMimeType(".jpeg"), "image/jpeg");
  assertEquals(agentIconMimeType(".webp"), "image/webp");
  // SVG is a document that can carry script: it is not an icon format even
  // though the visual store accepts it.
  assertEquals(agentIconMimeType(".svg"), undefined);
  assertEquals(agentIconMimeType(""), undefined);
  assertEquals(agentIconMimeType(".png.exe"), undefined);
});

Deno.test("agentIconExtensionOfMimeType: what the browser reported", () => {
  assertEquals(agentIconExtensionOfMimeType("image/png"), ".png");
  assertEquals(agentIconExtensionOfMimeType("IMAGE/PNG"), ".png");
  assertEquals(agentIconExtensionOfMimeType("image/jpeg"), ".jpg");
  assertEquals(agentIconExtensionOfMimeType("image/webp"), ".webp");
  assertEquals(agentIconExtensionOfMimeType("image/svg+xml"), undefined);
  assertEquals(agentIconExtensionOfMimeType("application/pdf"), undefined);
  assertEquals(agentIconExtensionOfMimeType(""), undefined);
  // Every extension the map carries maps back to one of them: the pair is
  // what the route accepts and the store writes.
  for (const extension of Object.keys(AGENT_ICON_MIME_BY_EXTENSION)) {
    const mime = agentIconMimeType(extension);
    assert(mime !== undefined);
    assert(
      agentIconMimeType(agentIconExtensionOfMimeType(mime)!) !== undefined,
    );
  }
});

Deno.test("MAX_AGENT_ICON_BYTES is a size an avatar can use", () => {
  // Large enough for a profile picture, small enough that a sidebar's worth
  // of them is not a directory of megabytes.
  assertSame(MAX_AGENT_ICON_BYTES, 512 * 1024);
});
