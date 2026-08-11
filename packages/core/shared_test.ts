import { assertEquals } from "@std/assert";
import {
  FAST_MODEL_KEY,
  IMAGE_MODEL_KEY,
  parseModelPreference,
  serializeModelPreference,
} from "./shared.ts";

Deno.test("model preference keys are distinct settings keys", () => {
  assertEquals(FAST_MODEL_KEY, "model_fast");
  assertEquals(IMAGE_MODEL_KEY, "model_image");
});

Deno.test("serialize/parse round-trips a model preference", () => {
  const pref = { provider: "openai", modelId: "gpt-4o-mini" };
  assertEquals(parseModelPreference(serializeModelPreference(pref)), pref);
});

Deno.test("parseModelPreference returns undefined for unset/empty/malformed", () => {
  assertEquals(parseModelPreference(undefined), undefined);
  assertEquals(parseModelPreference(null), undefined);
  assertEquals(parseModelPreference(""), undefined);
  assertEquals(parseModelPreference("not json"), undefined);
  assertEquals(parseModelPreference("{}"), undefined);
  assertEquals(
    parseModelPreference(JSON.stringify({ provider: "openai" })),
    undefined,
  );
  assertEquals(
    parseModelPreference(JSON.stringify({ provider: "openai", modelId: 42 })),
    undefined,
  );
});
