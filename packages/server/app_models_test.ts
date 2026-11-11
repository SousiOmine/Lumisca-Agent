import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, LumiscaCore } from "@lumisca/core";
import { removeDirRetry } from "@lumisca/core/test-utils";
import { assertEquals } from "@std/assert";
import { startServer } from "./app.ts";
import { json, setup } from "./test-utils.ts";

Deno.test("session model switch API", async () => {
  const { core, server, faux, base } = await setup();
  try {
    const root = await Deno.makeTempDir({ prefix: "lumisca-srv-" });
    const create = await json(base, "/api/workspaces", {
      method: "POST",
      body: JSON.stringify({ name: "ws", folders: [root] }),
    });
    const ws = await create.json();
    const sessionRes = await json(base, "/api/sessions", {
      method: "POST",
      body: JSON.stringify({
        workspaceId: ws.id,
        modelProvider: faux.provider.id,
        modelId: faux.getModel().id,
      }),
    });
    const session = await sessionRes.json();

    const res = await json(base, `/api/sessions/${session.id}/model`, {
      method: "POST",
      body: JSON.stringify({
        provider: faux.provider.id,
        modelId: faux.getModel().id,
      }),
    });
    assertEquals(res.status, 200);
    const updated = await res.json();
    assertEquals(updated.modelProvider, faux.provider.id);
    assertEquals(updated.modelId, faux.getModel().id);

    await removeDirRetry(root);
  } finally {
    server.shutdown();
    core.close();
  }
});

Deno.test("default model API follows the configured providers", async () => {
  const { core, server, faux, base } = await setup();
  try {
    // Nothing is configured: the built-in catalog entries are registered
    // but carry no credentials, so there is no default model at all (the
    // draft renders an unset model field and refuses to start).
    const empty = await fetch(`${base}/api/sessions/default-model`);
    assertEquals(empty.status, 200);
    assertEquals(await empty.json(), null);

    const root = await Deno.makeTempDir({ prefix: "lumisca-srv-" });
    const create = await json(base, "/api/workspaces", {
      method: "POST",
      body: JSON.stringify({ name: "ws", folders: [root] }),
    });
    const ws = await create.json();

    // A session without an explicit model is refused for the same reason
    // (503 "unavailable") instead of being created on an unusable model.
    const refused = await json(base, "/api/sessions", {
      method: "POST",
      body: JSON.stringify({ workspaceId: ws.id }),
    });
    assertEquals(refused.status, 503);

    // Storing a key makes the faux provider the configured one: now the
    // fallback resolves there, and a session without a model starts on it.
    await core.setProviderApiKey(faux.provider.id, "faux-key");
    const fallback = await (
      await fetch(`${base}/api/sessions/default-model`)
    ).json();
    assertEquals(fallback.provider, faux.provider.id);
    assertEquals(fallback.modelId, faux.getModel().id);

    const sessionRes = await json(base, "/api/sessions", {
      method: "POST",
      body: JSON.stringify({ workspaceId: ws.id }),
    });
    assertEquals(sessionRes.status, 201);
    const session = await sessionRes.json();
    assertEquals(session.modelProvider, faux.provider.id);
    assertEquals(session.modelId, faux.getModel().id);

    const res = await fetch(`${base}/api/sessions/default-model`);
    assertEquals(res.status, 200);
    const defaultModel = await res.json();
    assertEquals(defaultModel.provider, faux.provider.id);
    assertEquals(defaultModel.modelId, faux.getModel().id);

    // Removing the credential takes the default away again: a last used
    // model whose provider is no longer configured must not be resurrected.
    await core.logoutProvider(faux.provider.id);
    assertEquals(
      await (await fetch(`${base}/api/sessions/default-model`)).json(),
      null,
    );

    await removeDirRetry(root);
  } finally {
    server.shutdown();
    core.close();
  }
});

Deno.test("providers API ignores ambient env keys of built-in providers", async () => {
  // The ambient environment is the test's own object, not the process's (the
  // test runner shares one process environment across every file).
  const ambient: Record<string, string> = { ANTHROPIC_API_KEY: "sk-env-only" };
  const { core, server, base } = await setup(() => ambient);
  try {
    // The env key resolves (source is reported) but the provider is not
    // configured in Lumisca: it must not appear as "added".
    const res = await fetch(`${base}/api/providers`);
    assertEquals(res.status, 200);
    const providers = (await res.json()) as Array<{
      id: string;
      configured: boolean;
      source?: string;
    }>;
    const anthropic = providers.find((p) => p.id === "anthropic");
    assertEquals(anthropic?.configured, false);
    assertEquals(anthropic?.source, "ANTHROPIC_API_KEY");
    const huggingface = providers.find((p) => p.id === "huggingface");
    assertEquals(huggingface?.configured, false);

    // Storing the key in Lumisca flips it to configured.
    const set = await json(base, "/api/providers/anthropic/api-key", {
      method: "POST",
      body: JSON.stringify({ key: "sk-stored" }),
    });
    assertEquals(set.status, 200);
    const after = (await (
      await fetch(`${base}/api/providers/anthropic/auth`)
    ).json()) as { configured: boolean };
    assertEquals(after.configured, true);
  } finally {
    server.shutdown();
    core.close();
  }
});

Deno.test("settings API refuses to write credentials", async () => {
  const { core, server, base } = await setup();
  try {
    const res = await json(base, "/api/settings/api_key:anthropic", {
      method: "PUT",
      body: JSON.stringify({ value: "sk-leak" }),
    });
    assertEquals(res.status, 403);
    // Nothing was stored: the generic settings surface never sees the key.
    const list = await fetch(`${base}/api/settings`);
    const settings = (await list.json()) as Record<string, string>;
    assertEquals("api_key:anthropic" in settings, false);
  } finally {
    server.shutdown();
    core.close();
  }
});

Deno.test("settings API writes the model preferences the dialog offers", async () => {
  // Regression: the dialog's "default model" row writes
  // `PUT /api/settings/model_default`, and the key was missing from the
  // core's allow-list — the row failed only in the browser. This walks the
  // same path the client does, which the resolver tests skip (they write
  // with setSetting, the service path that has no allow-list).
  const { core, server, faux, base } = await setup();
  try {
    await core.setProviderApiKey(faux.provider.id, "faux-key");
    const pref = { provider: faux.provider.id, modelId: faux.getModel().id };
    const value = JSON.stringify(pref);

    const res = await json(base, "/api/settings/model_default", {
      method: "PUT",
      body: JSON.stringify({ value }),
    });
    assertEquals(res.status, 200);

    const settings = (await (
      await fetch(`${base}/api/settings`)
    ).json()) as Record<string, string>;
    assertEquals(settings.model_default, value);

    // The write is what a new conversation reads.
    const resolved = (await (
      await fetch(`${base}/api/sessions/default-model`)
    ).json()) as { provider: string; modelId: string };
    assertEquals(resolved.provider, pref.provider);
    assertEquals(resolved.modelId, pref.modelId);

    // Clearing the row (the dialog sends "") is a write too.
    const cleared = await json(base, "/api/settings/model_default", {
      method: "PUT",
      body: JSON.stringify({ value: "" }),
    });
    assertEquals(cleared.status, 200);

    // An invented key is still refused rather than persisted.
    const invented = await json(base, "/api/settings/model_mine", {
      method: "PUT",
      body: JSON.stringify({ value: value }),
    });
    assertEquals(invented.status, 400);
  } finally {
    server.shutdown();
    core.close();
  }
});

Deno.test("personalize API reads and writes AGENTS.md next to the settings file", async () => {
  const dir = await Deno.makeTempDir({ prefix: "lumisca-pers-" });
  const core = LumiscaCore.open(
    join(dir, "lumisca.db"),
    join(dir, "settings.jsonc"),
  );
  const server = startServer(core, 0);
  const base = `http://127.0.0.1:${server.addr.port}`;
  const agentFile = join(dir, "AGENTS.md");
  try {
    // Absent file → empty content, but the expected path is reported.
    const empty = await fetch(`${base}/api/personalize`);
    assertEquals(empty.status, 200);
    const emptyInfo = (await empty.json()) as { path: string; content: string };
    assertEquals(emptyInfo.path, agentFile);
    assertEquals(emptyInfo.content, "");

    const put = await json(base, "/api/personalize", {
      method: "PUT",
      body: JSON.stringify({ content: "Answer in Japanese.\n" }),
    });
    assertEquals(put.status, 200);
    assertEquals(Deno.readTextFileSync(agentFile), "Answer in Japanese.\n");

    const get = await fetch(`${base}/api/personalize`);
    const info = (await get.json()) as { path: string; content: string };
    assertEquals(info.path, agentFile);
    assertEquals(info.content, "Answer in Japanese.\n");

    const bad = await json(base, "/api/personalize", {
      method: "PUT",
      body: JSON.stringify({ content: 42 }),
    });
    assertEquals(bad.status, 400);
  } finally {
    server.shutdown();
    core.close();
    await removeDirRetry(dir);
  }
});

Deno.test("settings API never exposes credentials", async () => {
  const { core, server, base } = await setup();
  try {
    await core.setProviderApiKey("anthropic", "sk-secret-test-123");
    const res = await fetch(`${base}/api/settings`);
    assertEquals(res.status, 200);
    const settings = (await res.json()) as Record<string, string>;
    assertEquals(
      Object.keys(settings).some((k) => k.includes("api_key")),
      false,
    );
    assertEquals(Object.values(settings).includes("sk-secret-test-123"), false);
  } finally {
    server.shutdown();
    core.close();
  }
});

Deno.test("stella API: the conversation carries the conversation, never the model's context", async () => {
  // Two rules in one endpoint. The reported symptom was `Date: …` and
  // `On-demand tools` rows in stella's chat: they are `context`
  // publications — the model's history — and the conversation must not serve
  // them, while the session endpoint (code mode) keeps serving them (its
  // clients hold the model's history; the web's transcript draws no row for
  // them). The second rule is what the mode is for now: a turn that
  // stopped to use a tool is narration and stays in the model's history,
  // while the final turn's text is the agent's reply and reaches the screen
  // together with what it SENT with `send_chat`.
  const { core, faux, server, base } = await setup();
  try {
    await core.setProviderApiKey(faux.provider.id, "faux-key");
    core.setStellaVm({
      status: () =>
        Promise.resolve({ state: "stopped", vncPort: null, reason: "" }),
      start: () =>
        Promise.resolve({ state: "running", vncPort: 1, reason: "" }),
      stop: () => Promise.resolve(),
      vncPort: () => Promise.resolve(null),
    });
    const created = await json(base, "/api/stella/conversations", {
      method: "POST",
      body: JSON.stringify({ name: "Aide", role: "Help with the work." }),
    });
    // No collection route: agents are created at /stella/agents.
    assertEquals(created.status, 404);
    const agentRes = await json(base, "/api/stella/agents", {
      method: "POST",
      body: JSON.stringify({ name: "Aide", role: "Help with the work." }),
    });
    const agent = (await agentRes.json()) as { id: string; name: string };

    const opened = await json(base, `/api/stella/conversations/${agent.id}`);
    const openedBody = (await opened.json()) as { sessionId: string };
    const sessionId = openedBody.sessionId;

    // The model's own text, plus a message it SENT. The run also publishes
    // the session's context (date, on-demand tools) ahead of it.
    faux.setResponses([
      fauxAssistantMessage(
        [
          { type: "text", text: "作業メモ: 一覧を出すために bash を使った。" },
          fauxToolCall("send_chat", { text: "一覧を出しました。" }, "call-1"),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("まだ書くことはある。"),
    ]);
    const prompt = await json(
      base,
      `/api/stella/conversations/${agent.id}/prompt`,
      {
        method: "POST",
        body: JSON.stringify({ text: "bash で一覧を出して" }),
      },
    );
    assertEquals(prompt.status, 200);
    // Wait for the run to finish (the prompt endpoint is fire-and-forget).
    for (let i = 0; i < 200; i++) {
      const res = await json(
        base,
        `/api/stella/conversations/${agent.id}/messages`,
      );
      const body = (await res.json()) as { running: boolean };
      if (!body.running) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const snapshotRes = await json(
      base,
      `/api/stella/conversations/${agent.id}/messages`,
    );
    const snapshot = (await snapshotRes.json()) as {
      entries: Array<{ role: string; text: string; card: string | null }>;
      running: boolean;
    };
    // The user's prompt, what the agent sent, then the final turn's reply —
    // in order. The narration turn (the one that called send_chat) and the
    // model's context publications are not on the screen.
    assertEquals(snapshot.entries[0]?.role, "user");
    assertEquals(snapshot.entries[0]?.text, "bash で一覧を出して");
    const answers = snapshot.entries.filter(
      (entry) => entry.role === "assistant",
    );
    assertEquals(
      answers.map((entry) => entry.text),
      ["一覧を出しました。", "まだ書くことはある。"],
    );
    for (const entry of snapshot.entries) {
      assertEquals(entry.role === "user" || entry.role === "assistant", true);
      // The model's context publications (date, on-demand tools) are not
      // entries; nor are tool results or notifications.
      assertEquals(entry.text.startsWith("Date:"), false, entry.text);
      assertEquals(entry.text.startsWith("On-demand tools"), false, entry.text);
      // Nor is the model's narration: it is the working notes of a turn that
      // went on to call a tool, not a reply.
      assertEquals(entry.text.includes("作業メモ"), false, entry.text);
    }

    // The code-mode session endpoint still serves the whole transcript
    // (context included): the split is in the endpoint, not in the store.
    const sessionRes = await json(base, `/api/sessions/${sessionId}/messages`);
    const session = (await sessionRes.json()) as {
      messages: Array<{ role: string }>;
    };
    assertEquals(
      session.messages.some((m) => m.role === "context"),
      true,
      "the model's context stays in the session transcript",
    );
    // The agent's own rows stay in the transcript too: the store and the
    // session endpoint keep the model's whole history, and a conversation
    // projects its replies out of it.
    const assistant = (await (
      await json(base, `/api/sessions/${sessionId}/messages`)
    ).json()) as {
      messages: Array<{ role: string; content?: unknown }>;
    };
    assertEquals(
      assistant.messages.some((m) => m.role === "assistant"),
      true,
      "the model's own turn stays in its history",
    );
  } finally {
    server.shutdown();
    await core.close();
  }
});
