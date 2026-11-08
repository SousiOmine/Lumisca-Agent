import { assertEquals, assertThrows } from "@std/assert";
import { CoreError } from "../errors.ts";
import { MCP_OAUTH_KEY_PREFIX } from "../mcp/oauth.ts";
import { APP_MCP_SETTINGS_KEY, CONNECTIONS_KEY } from "../shared/mod.ts";
import {
  DEFAULT_MODEL_KEY,
  FAST_MODEL_KEY,
  IMAGE_MODEL_KEY,
  PUSH_SUBSCRIPTIONS_KEY,
  PUSH_VAPID_KEY,
} from "../shared/settings-keys.ts";
import { CREDENTIAL_KEY_PREFIX } from "./credentials.ts";
import {
  assertMutableKey,
  filterExposedSettings,
  protectedKeyReason,
} from "./guard.ts";

Deno.test("the settings guard hides every credential category", () => {
  for (
    const key of [
      `${CREDENTIAL_KEY_PREFIX}anthropic`,
      // MCP OAuth tokens and client registrations (see mcp/oauth.ts).
      `${MCP_OAUTH_KEY_PREFIX}https://agent.example/mcp`,
      APP_MCP_SETTINGS_KEY,
      CONNECTIONS_KEY,
      // Web Push: the signing key, and the endpoints that can be notified.
      PUSH_VAPID_KEY,
      PUSH_SUBSCRIPTIONS_KEY,
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

// Regression: the settings dialog's model rows are written through the
// generic settings surface, and `model_default` was added to the dialog
// without its declaration here. Nothing else caught it, because the tests
// that set a default model write with `setSetting`, which skips this check —
// the failure only appeared in the browser as "保存に失敗しました: Unknown
// setting: model_default".
Deno.test("the model rows of the settings dialog are writable", () => {
  for (const key of [DEFAULT_MODEL_KEY, FAST_MODEL_KEY, IMAGE_MODEL_KEY]) {
    // Throws (and so fails this test) when the key is missing from the
    // allow-list.
    assertMutableKey(key);
  }
});

Deno.test("a key the client invented is refused", () => {
  assertThrows(
    () => assertMutableKey("model_mine"),
    CoreError,
    "Unknown setting",
  );
});
