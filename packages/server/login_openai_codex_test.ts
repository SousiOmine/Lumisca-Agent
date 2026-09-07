// Credential-store persistence test for the Lumisca API-key auth path.
// The migration moved the AI core to Vercel AI SDK with "credential store +
// key injection": providers are configured by storing an API key (or an
// ambient env var), not by an interactive OAuth device-code flow. This test
// proves the store → configured-auth round trip without touching the network.
import { assertEquals } from "@std/assert";
import { LumiscaCore } from "@lumisca/core";

Deno.test("stored API keys drive the configured-auth check", async () => {
  const core = LumiscaCore.forTesting();
  try {
    // A built-in provider with no stored key and a cleaned env is not
    // configured in Lumisca.
    assertEquals(await core.hasConfiguredAuth("openai"), false);
    assertEquals(await core.hasProviderAuth("openai"), false);

    // Storing a key makes it configured (the key-injection path).
    await core.setProviderApiKey("openai", "sk-test");
    assertEquals(await core.hasConfiguredAuth("openai"), true);
    assertEquals(await core.hasProviderAuth("openai"), true);

    // Logging out clears the configured state again.
    await core.logoutProvider("openai");
    assertEquals(await core.hasConfiguredAuth("openai"), false);
  } finally {
    core.close();
  }
});
