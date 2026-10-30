import { assert, assertEquals, assertThrows } from "@std/assert";
import { LumiscaCore } from "./core.ts";
import { CoreError } from "./errors.ts";
import { WEB_SEARCH_KEY } from "./shared/settings-keys.ts";
import { fauxProvider } from "./ai/faux.ts";

/**
 * The web-search setting through the core: the facade the server calls.
 *
 * What is pinned here is the contract the settings screen and the agent
 * depend on — a key never comes back out, the first provider becomes the
 * default, and only a configured default gives a session the web tools.
 */

Deno.test("core: the web-search view never carries a key", async () => {
  const core = LumiscaCore.forTesting();
  try {
    const empty = core.getWebSearchSettings();
    assertEquals(empty.defaultId, null);
    assertEquals(empty.providers, []);
    assertEquals(empty.available.length, 5);

    const added = core.addWebSearchProvider({ id: "exa", apiKey: "s3cret" });
    assertEquals(added.defaultId, "exa");
    assertEquals(added.providers.length, 1);
    // Whether a key is stored is all a client may learn.
    assertEquals(added.providers[0]?.hasApiKey, true);
    assert(!JSON.stringify(added).includes("s3cret"));
    // The generic settings surface refuses the entry that holds it.
    assertThrows(
      () => core.setSetting(WEB_SEARCH_KEY, "{}"),
      CoreError,
      "cannot be accessed",
    );
    assertEquals(core.listSettings().has(WEB_SEARCH_KEY), false);
  } finally {
    await core.close();
  }
});

Deno.test("core: removing the default hands it to the remaining provider", async () => {
  const core = LumiscaCore.forTesting();
  try {
    core.addWebSearchProvider({ id: "exa", apiKey: "k" });
    core.addWebSearchProvider({ id: "tavily", apiKey: "k" });
    const removed = core.removeWebSearchProvider("exa");
    assertEquals(removed.defaultId, "tavily");
    assertEquals(removed.providers.map((p) => p.id), ["tavily"]);

    // Removing the last provider leaves nothing to search with.
    const empty = core.removeWebSearchProvider("tavily");
    assertEquals(empty.defaultId, null);
    assertEquals(empty.providers, []);
  } finally {
    await core.close();
  }
});

Deno.test("core: unknown provider ids are refused", async () => {
  const core = LumiscaCore.forTesting();
  try {
    assertThrows(
      () => core.addWebSearchProvider({ id: "nope", apiKey: "k" }),
      CoreError,
      "Unknown web search provider",
    );
    assertThrows(
      () => core.setDefaultWebSearchProvider("nope"),
      CoreError,
      "Unknown web search provider",
    );
    assertThrows(
      () => core.removeWebSearchProvider("nope"),
      CoreError,
    );
    assertThrows(
      () => core.updateWebSearchProvider("exa", { apiKey: "k" }),
      CoreError,
      "not found",
    );
  } finally {
    await core.close();
  }
});

/** Whether the session's snapshotted prompt carries the web-search
 * guideline. The prompt is built from the tool set the session actually has
 * (agent/factory.ts), so it is the observable proof that the pair was
 * preloaded — and that it was absent when no provider was configured. */
function promptHasWebTools(core: LumiscaCore, sessionId: string): boolean {
  const prompt = core.getSession(sessionId)?.systemPrompt ?? "";
  return prompt.includes("Use web_search");
}

Deno.test("core: a search provider becomes the session's web tools", async () => {
  // The faux provider lets the session be opened without a network or a key.
  const faux = fauxProvider();
  const core = LumiscaCore.forTesting([faux.provider]);
  // A new session needs a provider with a key to resolve a default model.
  await core.setProviderApiKey(faux.provider.id, "faux-key");
  try {
    const workspace = await core.createWorkspace("web", [Deno.cwd()]);

    // No provider configured: a new session is not given the web tools, and
    // its prompt does not point at them.
    const plain = await core.createSession({ workspaceId: workspace.id });
    assertEquals(promptHasWebTools(core, plain.id), false);

    core.addWebSearchProvider({ id: "brave", apiKey: "k" });
    const configured = await core.createSession({ workspaceId: workspace.id });
    // The prompt is built from the tool set the session actually has, so a
    // session created after the provider was added carries the guidance that
    // is keyed on the pair.
    assert(promptHasWebTools(core, configured.id));

    // Clearing the default keeps the configuration but stops search: the
    // next session gets no web tools again.
    core.setDefaultWebSearchProvider(null);
    const off = await core.createSession({ workspaceId: workspace.id });
    assertEquals(promptHasWebTools(core, off.id), false);
  } finally {
    await core.close();
  }
});
