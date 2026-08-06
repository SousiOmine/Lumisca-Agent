import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { assertEquals } from "@std/assert";

Deno.test("pi-ai loads builtin models in Deno", () => {
  const models = builtinModels();
  const providers = models.getProviders();
  assertEquals(providers.length > 0, true, "at least one provider registered");
  const all = models.getModels();
  assertEquals(all.length > 0, true, "at least one model");
});
