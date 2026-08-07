import { assertEquals } from "@std/assert";
import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
  isThinkingLevel,
} from "./thinking.ts";

Deno.test("getSupportedThinkingLevels: non-reasoning models only support off", () => {
  assertEquals(getSupportedThinkingLevels({ reasoning: false }), ["off"]);
  assertEquals(getSupportedThinkingLevels({}), ["off"]);
  assertEquals(getSupportedThinkingLevels(undefined), ["off"]);
});

Deno.test("getSupportedThinkingLevels: reasoning model without a map", () => {
  // Without a map, the provider defaults apply: everything except xhigh/max
  // (those require an explicit map entry).
  assertEquals(getSupportedThinkingLevels({ reasoning: true }), [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
  ]);
});

Deno.test("getSupportedThinkingLevels: map entries filter levels", () => {
  assertEquals(
    getSupportedThinkingLevels({
      reasoning: true,
      thinkingLevelMap: {
        off: null, // model cannot turn thinking off
        medium: null, // ...or think at medium
        xhigh: "xhigh",
        max: "max",
      },
    }),
    ["minimal", "low", "high", "xhigh", "max"],
  );
});

Deno.test("clampThinkingLevel: supported levels pass through", () => {
  const model = { reasoning: true };
  assertEquals(clampThinkingLevel(model, "off"), "off");
  assertEquals(clampThinkingLevel(model, "medium"), "medium");
});

Deno.test("clampThinkingLevel: unsupported levels clamp to nearest", () => {
  const model = { reasoning: true };
  // xhigh/max need a map entry; request clamps down to high.
  assertEquals(clampThinkingLevel(model, "max"), "high");
  assertEquals(clampThinkingLevel(model, "xhigh"), "high");
  // A non-reasoning model clamps everything to off.
  assertEquals(clampThinkingLevel({ reasoning: false }, "high"), "off");
});

Deno.test("clampThinkingLevel: map-filtered levels", () => {
  const model = {
    reasoning: true,
    thinkingLevelMap: {
      off: null,
      medium: null,
      xhigh: "xhigh",
      max: "max",
    },
  };
  // medium is unsupported: clamp up to high, not down to low.
  assertEquals(clampThinkingLevel(model, "medium"), "high");
  assertEquals(clampThinkingLevel(model, "max"), "max");
  // off is unsupported: clamp up to minimal.
  assertEquals(clampThinkingLevel(model, "off"), "minimal");
});

Deno.test("isThinkingLevel accepts only known levels", () => {
  assertEquals(isThinkingLevel("off"), true);
  assertEquals(isThinkingLevel("max"), true);
  assertEquals(isThinkingLevel("high"), true);
  assertEquals(isThinkingLevel("turbo"), false);
  assertEquals(isThinkingLevel(""), false);
  assertEquals(isThinkingLevel(undefined), false);
});
