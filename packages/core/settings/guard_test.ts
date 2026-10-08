import { assertEquals } from "@std/assert";
import { filterExposedSettings, protectedKeyReason } from "./guard.ts";
import { CREDENTIAL_KEY_PREFIX } from "./credentials.ts";
import { MCP_OAUTH_KEY_PREFIX } from "../mcp/oauth.ts";
import { APP_MCP_SETTINGS_KEY, CONNECTIONS_KEY } from "../shared/mod.ts";

Deno.test("the settings guard hides every credential category", () => {
  for (
    const key of [
      `${CREDENTIAL_KEY_PREFIX}anthropic`,
      // MCP OAuth tokens and client registrations (see mcp/oauth.ts).
      `${MCP_OAUTH_KEY_PREFIX}https://agent.example/mcp`,
      APP_MCP_SETTINGS_KEY,
      CONNECTIONS_KEY,
    ]
  ) {
    assertEquals(
      typeof protectedKeyReason(key) !== "undefined",
      true,
      `${key} must be protected`,
    );
  }
  // Ordinary settings stay readable, and only the prefixed form counts.
  assertEquals(protectedKeyReason("locale"), undefined);
  assertEquals(protectedKeyReason("mcp_oauth"), undefined);
});

Deno.test("filterExposedSettings drops the protected entries only", () => {
  const all = new Map([
    ["locale", "ja"],
    [`${MCP_OAUTH_KEY_PREFIX}https://a.example/mcp`, '{"tokens":{}}'],
    [`${CREDENTIAL_KEY_PREFIX}openai`, '{"key":"sk-test"}'],
    ["theme", "dark"],
  ]);
  assertEquals([...filterExposedSettings(all).keys()], ["locale", "theme"]);
});
