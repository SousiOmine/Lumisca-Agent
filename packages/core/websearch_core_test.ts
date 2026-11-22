import { test } from "bun:test";
import { forTestingCore } from "@lumisca/core";
import { assert, assertEquals, assertThrows } from "@std/assert";
import { fauxProvider } from "./ai/faux.ts";
import type { LumiscaCore } from "./core.ts";
import { CoreError } from "./errors.ts";
import { WEB_SEARCH_KEY } from "./shared/settings-keys.ts";

/**
 * The web-search setting through the core: the facade the server calls.
 *
 * What is pinned here is the contract the settings screen and the agent
 * depend on — a key never comes back out, the first provider becomes the
 * default, and only a configured default gives a session the web tools.
 */

test("core: the web-search view never carries a key", async () => {
  const core = forTestingCore();
  try {
    const empty = core.services.webSearch.view();
    assertEquals(empty.defaultId, null);
    assertEquals(empty.providers, []);
    assertEquals(empty.available.length, 5);

    const added = core.services.webSearch.add({ id: "exa", apiKey: "s3cret" });
    assertEquals(added.defaultId, "exa");
    assertEquals(added.providers.length, 1);
    // Whether a key is stored is all a client may learn.
    assertEquals(added.providers[0]?.hasApiKey, true);
    assert(!JSON.stringify(added).includes("s3cret"));
    // The generic settings surface refuses the entry that holds it.
    assertThrows(
      () => core.settings.set(WEB_SEARCH_KEY, "{}"),
      CoreError,
      "cannot be accessed",
    );
    assertEquals(core.settings.list().has(WEB_SEARCH_KEY), false);
  } finally {
    await core.close();
  }
});

test("core: removing the default hands it to the remaining provider", async () => {
  const core = forTestingCore();
  try {
    core.services.webSearch.add({ id: "exa", apiKey: "k" });
    core.services.webSearch.add({ id: "tavily", apiKey: "k" });
    const removed = core.services.webSearch.remove("exa");
    assertEquals(removed.defaultId, "tavily");
    assertEquals(
      removed.providers.map((p) => p.id),
      ["tavily"],
    );

    // Removing the last provider leaves nothing to search with.
    const empty = core.services.webSearch.remove("tavily");
    assertEquals(empty.defaultId, null);
    assertEquals(empty.providers, []);
  } finally {
    await core.close();
  }
});

test("core: unknown provider ids are refused", async () => {
  const core = forTestingCore();
  try {
    assertThrows(
      () => core.services.webSearch.add({ id: "nope", apiKey: "k" }),
      CoreError,
      "Unknown web search provider",
    );
    assertThrows(
      () => core.services.webSearch.setDefault("nope"),
      CoreError,
      "Unknown web search provider",
    );
    assertThrows(() => core.services.webSearch.remove("nope"), CoreError);
    assertThrows(
      () => core.services.webSearch.update("exa", { apiKey: "k" }),
      CoreError,
      "not found",
    );
  } finally {
    await core.close();
  }
});

/** Whether the session has the web-search pair. Read from the session's
 * own tool list: the prompt names no tools (see tools/system-prompt.ts), so
 * the preloaded tools themselves are the observable proof that the pair was
 * attached — and that it was absent when no provider was configured. */
function sessionHasWebTools(core: LumiscaCore, sessionId: string): boolean {
  const names = core.services.sessions.getAgent(sessionId)?.toolNames ?? [];
  return names.includes("web_search") && names.includes("web_fetch");
}

test("core: a search provider becomes the session's web tools", async () => {
  // The faux provider lets the session be opened without a network or a key.
  const faux = fauxProvider();
  const core = forTestingCore([faux.provider]);
  // A new session needs a provider with a key to resolve a default model.
  await core.services.models.setProviderApiKey(faux.provider.id, "faux-key");
  try {
    const workspace = await core.services.workspaces.create("web", [
      process.cwd(),
    ]);

    // No provider configured: a new session is not given the web tools, and
    // its prompt does not point at them.
    const plain = await core.services.sessions.createSession({
      workspaceId: workspace.id,
    });
    assertEquals(sessionHasWebTools(core, plain.id), false);

    core.services.webSearch.add({ id: "brave", apiKey: "k" });
    const configured = await core.services.sessions.createSession({
      workspaceId: workspace.id,
    });
    // The tool set is built per session, so one created after the provider
    // was added carries the pair.
    assert(sessionHasWebTools(core, configured.id));

    // Clearing the default keeps the configuration but stops search: the
    // next session gets no web tools again.
    core.services.webSearch.setDefault(null);
    const off = await core.services.sessions.createSession({
      workspaceId: workspace.id,
    });
    assertEquals(sessionHasWebTools(core, off.id), false);
  } finally {
    await core.close();
  }
});
