import { test } from "bun:test";
import { assertEquals, assertThrows } from "@std/assert";
import { CoreError } from "../errors.ts";
import { MCP_OAUTH_KEY_PREFIX } from "../mcp/oauth.ts";
import { APP_MCP_SETTINGS_KEY, CONNECTIONS_KEY } from "../shared/mod.ts";
import {
  AGENT_IDENTITY_EDIT_KEY,
  APP_UI_IN_SYSTEM_PROMPT_KEY,
  ASK_TOOL_ENABLED_KEY,
  CODE_EXECUTION_ENABLED_KEY,
  CODE_MODE_ENABLED_KEY,
  COMPACTION_ENABLED_KEY,
  COMPACTION_RESERVE_PERCENT_KEY,
  DEFAULT_MODEL_KEY,
  FAST_MODEL_KEY,
  IMAGE_MODEL_KEY,
  PUSH_SUBSCRIPTIONS_KEY,
  PUSH_VAPID_KEY,
  STELLA_KEEP_FULL_LOG_KEY,
} from "../shared/settings-keys.ts";
import { CREDENTIAL_KEY_PREFIX } from "./credentials.ts";
import {
  assertMutableKey,
  filterExposedSettings,
  protectedKeyReason,
} from "./guard.ts";

test("the settings guard hides every credential category", () => {
  for (const key of [
    `${CREDENTIAL_KEY_PREFIX}anthropic`,
    // MCP OAuth tokens and client registrations (see mcp/oauth.ts).
    `${MCP_OAUTH_KEY_PREFIX}https://agent.example/mcp`,
    APP_MCP_SETTINGS_KEY,
    CONNECTIONS_KEY,
    // Web Push: the signing key, and the endpoints that can be notified.
    PUSH_VAPID_KEY,
    PUSH_SUBSCRIPTIONS_KEY,
  ]) {
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

test("filterExposedSettings drops the protected entries only", () => {
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
test("the model rows of the settings dialog are writable", () => {
  for (const key of [DEFAULT_MODEL_KEY, FAST_MODEL_KEY, IMAGE_MODEL_KEY]) {
    // Throws (and so fails this test) when the key is missing from the
    // allow-list.
    assertMutableKey(key);
  }
});

test("the compaction rows of the settings dialog are writable", () => {
  // Same surface, same failure mode: a row added to the panel without its
  // declaration here only fails in the browser, as "Unknown setting".
  for (const key of [
    COMPACTION_ENABLED_KEY,
    COMPACTION_RESERVE_PERCENT_KEY,
    STELLA_KEEP_FULL_LOG_KEY,
  ]) {
    assertMutableKey(key);
  }
});

test("the experimental rows of the settings dialog are writable", () => {
  // Same surface, same failure mode (see the model and compaction rows).
  for (const key of [
    CODE_EXECUTION_ENABLED_KEY,
    CODE_MODE_ENABLED_KEY,
    ASK_TOOL_ENABLED_KEY,
    APP_UI_IN_SYSTEM_PROMPT_KEY,
    AGENT_IDENTITY_EDIT_KEY,
  ]) {
    assertMutableKey(key);
  }
});

test("a key the client invented is refused", () => {
  assertThrows(
    () => assertMutableKey("model_mine"),
    CoreError,
    "Unknown setting",
  );
});
