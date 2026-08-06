import { builtinModels } from "npm:@earendil-works/pi-ai@0.83.0/providers/all";
import { assertEquals } from "jsr:@std/assert";

Deno.test("pi-ai loads builtin models in Deno", () => {
  const models = builtinModels();
  const providers = models.getProviders();
  assertEquals(providers.length > 0, true, "at least one provider registered");
  const all = models.getModels();
  assertEquals(all.length > 0, true, "at least one model");
});
