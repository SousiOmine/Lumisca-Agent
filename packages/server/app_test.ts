import { join } from "node:path";
import { realpathSync } from "node:fs";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { assertEquals } from "@std/assert";
import { LumiscaCore, type TodoPhase } from "@lumisca/core";
import { COMMAND_SAFETY_APPROVALS_KEY } from "@lumisca/core/shared";
import {
  createApp,
  disposeServer,
  isLoopbackHost,
  startServer,
  validateHostConfig,
} from "./app.ts";
function setup() {
  const faux = fauxProvider();
  const core = LumiscaCore.forTesting([faux.provider]);
  const server = startServer(core, 0);
  const port = server.addr.port;
  const base = `http://127.0.0.1:${port}`;
  return { core, server, faux, base };
}

/** Windows can hold a directory handle briefly after a spawned child exits;
 * retry removal instead of failing the test. */
async function removeDirRetry(path: string): Promise<void> {
  for (let i = 0; i < 20; i++) {
    try {
      await Deno.remove(path, { recursive: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  await Deno.remove(path, { recursive: true }); // last attempt: surface errors
}

function json(
  base: string,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return fetch(`${base}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
}

Deno.test("health and workspaces API", async () => {
  const { core, server, base } = await setup();
  try {
    const health = await fetch(`${base}/api/health`);
    assertEquals(health.status, 200);

    const root = await Deno.makeTempDir({ prefix: "lumisca-srv-" });
    const create = await json(base, "/api/workspaces", {
      method: "POST",
      body: JSON.stringify({ name: "ws", folders: [root] }),
    });
    assertEquals(create.status, 201);
    const ws = await create.json();
    assertEquals(ws.folders[0], realpathSync(root));

    const list = await json(base, "/api/workspaces");
    const workspaces = await list.json();
    assertEquals(workspaces.length, 1);

    const bad = await json(base, "/api/workspaces", {
      method: "POST",
      body: JSON.stringify({ name: "bad", folders: [joinMissing()] }),
    });
    assertEquals(bad.status, 400);

    await Deno.remove(root, { recursive: true });
  } finally {
    server.shutdown();
    core.close();
  }
});

Deno.test("workspace files API returns @-mention suggestions", async () => {
  const { core, server, base } = await setup();
  try {
    const root = await Deno.makeTempDir({ prefix: "lumisca-srv-" });
    const create = await json(base, "/api/workspaces", {
      method: "POST",
      body: JSON.stringify({ name: "ws", folders: [root] }),
    });
    const ws = await create.json();
    await Deno.mkdir(join(root, "src"), { recursive: true });
    await Deno.writeTextFile(join(root, "src", "main.ts"), "m");
    await Deno.writeTextFile(join(root, "README.md"), "r");

    const folderName = Deno.build.os === "windows"
      ? root.split("\\").pop()!
      : root.split("/").pop()!;

    const all = await json(base, `/api/workspaces/${ws.id}/files`);
    assertEquals(all.status, 200);
    const allEntries = (await all.json()).entries;
    const allPaths = allEntries.map((e: { path: string }) => e.path);
    assertEquals(allPaths.includes(`${folderName}/README.md`), true);
    assertEquals(allPaths.includes(`${folderName}/src/main.ts`), true);

    const filtered = await json(
      base,
      `/api/workspaces/${ws.id}/files?query=${encodeURIComponent("main")}`,
    );
    const filteredPaths = (await filtered.json()).entries.map(
      (e: { path: string }) => e.path,
    );
    assertEquals(filteredPaths, [`${folderName}/src/main.ts`]);

    const unknown = await json(base, "/api/workspaces/nope/files");
    assertEquals(unknown.status, 404);

    await Deno.remove(root, { recursive: true });
  } finally {
    server.shutdown();
    core.close();
  }
});

Deno.test("workspace update and delete API", async () => {
  const { core, server, base } = await setup();
  try {
    const root = await Deno.makeTempDir({ prefix: "lumisca-srv-" });
    const extra = await Deno.makeTempDir({ prefix: "lumisca-srv-" });
    const create = await json(base, "/api/workspaces", {
      method: "POST",
      body: JSON.stringify({ name: "ws", folders: [root] }),
    });
    const ws = await create.json();

    const patch = await json(base, `/api/workspaces/${ws.id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "renamed", folders: [root, extra] }),
    });
    assertEquals(patch.status, 200);
    const updated = await patch.json();
    assertEquals(updated.name, "renamed");
    assertEquals(updated.folders.length, 2);

    const nameOnly = await json(base, `/api/workspaces/${ws.id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "again" }),
    });
    assertEquals(nameOnly.status, 200);
    assertEquals((await nameOnly.json()).name, "again");

    const bad = await json(base, `/api/workspaces/${ws.id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: 42 }),
    });
    assertEquals(bad.status, 400);

    const del = await json(base, `/api/workspaces/${ws.id}`, {
      method: "DELETE",
    });
    assertEquals(del.status, 200);
    const after = await json(base, "/api/workspaces");
    assertEquals((await after.json()).length, 0);

    await Deno.remove(root, { recursive: true });
    await Deno.remove(extra, { recursive: true });
  } finally {
    server.shutdown();
    core.close();
  }
});

Deno.test("session prompt roundtrip via API", async () => {
  const { core, server, faux, base } = await setup();
  try {
    const root = await Deno.makeTempDir({ prefix: "lumisca-srv-" });
    const create = await json(base, "/api/workspaces", {
      method: "POST",
      body: JSON.stringify({ name: "ws", folders: [root] }),
    });
    const ws = await create.json();

    faux.setResponses([fauxAssistantMessage("Hello via API!")]);
    const sessionRes = await json(base, "/api/sessions", {
      method: "POST",
      body: JSON.stringify({
        workspaceId: ws.id,
        modelProvider: faux.provider.id,
        modelId: faux.getModel().id,
        name: "api-test",
      }),
    });
    assertEquals(sessionRes.status, 201);
    const session = await sessionRes.json();

    const promptRes = await json(base, `/api/sessions/${session.id}/prompt`, {
      method: "POST",
      body: JSON.stringify({ text: "Hi" }),
    });
    assertEquals(promptRes.status, 200);

    const messagesRes = await json(
      base,
      `/api/sessions/${session.id}/messages`,
    );
    const messages = await messagesRes.json();
    assertEquals(messages.length, 2);
    assertEquals(messages[1].role, "assistant");

    await Deno.remove(root, { recursive: true });
  } finally {
    server.shutdown();
    core.close();
  }
});

Deno.test("chat session API: no workspaceId creates a chat session", async () => {
  const { core, server, faux, base } = await setup();
  try {
    faux.setResponses([fauxAssistantMessage("chat reply")]);

    // No workspaceId → a chat session (chat flag set, folder-less).
    const create = await json(base, "/api/sessions", {
      method: "POST",
      body: JSON.stringify({
        modelProvider: faux.provider.id,
        modelId: faux.getModel().id,
      }),
    });
    assertEquals(create.status, 201);
    const session = await create.json();
    assertEquals(session.chat, true);

    // The chat workspace is internal: it never appears in the workspace
    // list API (clients see only manageable workspaces).
    const wsList = await json(base, "/api/workspaces");
    const workspaces = await wsList.json();
    assertEquals(workspaces.length, 0);
    assertEquals(
      workspaces.some((ws: { chat: boolean }) => ws.chat),
      false,
    );
    const chatWs = core.getWorkspace(session.workspaceId)!;
    assertEquals(chatWs.chat, true);

    // The chat session prompts and answers like any other.
    const promptRes = await json(base, `/api/sessions/${session.id}/prompt`, {
      method: "POST",
      body: JSON.stringify({ text: "Hi" }),
    });
    assertEquals(promptRes.status, 200);
    const messagesRes = await json(
      base,
      `/api/sessions/${session.id}/messages`,
    );
    const messages = await messagesRes.json();
    assertEquals(messages.length, 2);
    assertEquals(messages[1].content[0].text, "chat reply");

    // The chat workspace refuses update/delete through the API.
    const del = await json(base, `/api/workspaces/${chatWs.id}`, {
      method: "DELETE",
    });
    assertEquals(del.status, 403);
    const patch = await json(base, `/api/workspaces/${chatWs.id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "nope" }),
    });
    assertEquals(patch.status, 403);
  } finally {
    server.shutdown();
    core.close();
  }
});

Deno.test("rewind truncates messages via the API and rejects bad bodies", async () => {
  const { core, server, faux, base } = await setup();
  try {
    const root = await Deno.makeTempDir({ prefix: "lumisca-srv-" });
    const create = await json(base, "/api/workspaces", {
      method: "POST",
      body: JSON.stringify({ name: "ws", folders: [root] }),
    });
    const ws = await create.json();

    faux.setResponses([
      fauxAssistantMessage("first reply"),
      fauxAssistantMessage("second reply"),
    ]);
    const sessionRes = await json(base, "/api/sessions", {
      method: "POST",
      body: JSON.stringify({
        workspaceId: ws.id,
        modelProvider: faux.provider.id,
        modelId: faux.getModel().id,
      }),
    });
    const session = await sessionRes.json();

    // Two prompts; the prompt endpoint is fire-and-forget, so poll until
    // both turns are in the transcript. The pause keeps the user messages
    // in distinct milliseconds — the rewind target is matched by role +
    // timestamp, and the faux provider can finish a turn within one
    // millisecond.
    await json(base, `/api/sessions/${session.id}/prompt`, {
      method: "POST",
      body: JSON.stringify({ text: "one" }),
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await json(base, `/api/sessions/${session.id}/prompt`, {
      method: "POST",
      body: JSON.stringify({ text: "two" }),
    });
    let messages: Array<{ role: string; timestamp: number }> = [];
    for (let i = 0; i < 100 && messages.length < 4; i++) {
      messages = await (
        await json(base, `/api/sessions/${session.id}/messages`)
      ).json();
      if (messages.length < 4) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    assertEquals(messages.length, 4);

    // Bad bodies are rejected with 400.
    const noTimestamp = await json(base, `/api/sessions/${session.id}/rewind`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    assertEquals(noTimestamp.status, 400);
    const stringTimestamp = await json(
      base,
      `/api/sessions/${session.id}/rewind`,
      { method: "POST", body: JSON.stringify({ timestamp: "300" }) },
    );
    assertEquals(stringTimestamp.status, 400);

    // Rewind the second turn: only the first turn remains.
    const rewindRes = await json(base, `/api/sessions/${session.id}/rewind`, {
      method: "POST",
      body: JSON.stringify({ timestamp: messages[2]!.timestamp }),
    });
    assertEquals(rewindRes.status, 200);
    const truncated = await (
      await json(base, `/api/sessions/${session.id}/messages`)
    ).json();
    assertEquals(truncated.length, 2);
    assertEquals(truncated[0].role, "user");
    assertEquals(truncated[1].role, "assistant");

    // Unknown timestamps map to 404.
    const unknown = await json(base, `/api/sessions/${session.id}/rewind`, {
      method: "POST",
      body: JSON.stringify({ timestamp: 1 }),
    });
    assertEquals(unknown.status, 404);

    await Deno.remove(root, { recursive: true });
  } finally {
    server.shutdown();
    core.close();
  }
});

Deno.test("websocket streams agent events", async () => {
  const { core, server, faux, base } = await setup();
  try {
    const root = await Deno.makeTempDir({ prefix: "lumisca-srv-" });
    const create = await json(base, "/api/workspaces", {
      method: "POST",
      body: JSON.stringify({ name: "ws", folders: [root] }),
    });
    const ws = await create.json();

    faux.setResponses([fauxAssistantMessage("Streamed!")]);
    const sessionRes = await json(base, "/api/sessions", {
      method: "POST",
      body: JSON.stringify({
        workspaceId: ws.id,
        modelProvider: faux.provider.id,
        modelId: faux.getModel().id,
      }),
    });
    const session = await sessionRes.json();

    const socket = new WebSocket(`ws://127.0.0.1:${server.addr.port}/ws`);
    const events: string[] = [];
    const done = new Promise<void>((resolve) => {
      socket.onmessage = (e) => {
        const event = JSON.parse(String(e.data));
        events.push(event.type);
        if (event.type === "agent_end") resolve();
      };
      socket.onopen = () => {
        json(base, `/api/sessions/${session.id}/prompt`, {
          method: "POST",
          body: JSON.stringify({ text: "Hi" }),
        });
      };
    });

    await done;
    socket.close();
    assertEquals(events.includes("agent_start"), true);
    assertEquals(events.includes("message_end"), true);
    assertEquals(events.includes("agent_end"), true);

    await Deno.remove(root, { recursive: true });
  } finally {
    server.shutdown();
    core.close();
  }
});

Deno.test("model enablement API", async () => {
  const { core, server, faux, base } = await setup();
  try {
    const modelsRes = await fetch(
      `${base}/api/providers/${faux.provider.id}/models`,
    );
    assertEquals(modelsRes.status, 200);
    const models = await modelsRes.json() as Array<
      { id: string; enabled: boolean }
    >;
    assertEquals(models.length > 0, true);
    assertEquals(
      models.every((m) => m.enabled === true),
      true,
      "default enabled",
    );

    const target = models[0]!;
    const put = await fetch(
      `${base}/api/providers/${faux.provider.id}/models/${
        encodeURIComponent(target.id)
      }`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      },
    );
    assertEquals(put.status, 200);

    const models2 = await (
      await fetch(`${base}/api/providers/${faux.provider.id}/models`)
    ).json() as Array<{ id: string; enabled: boolean }>;
    assertEquals(models2.find((m) => m.id === target.id)?.enabled, false);
  } finally {
    server.shutdown();
    core.close();
  }
});

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

    await Deno.remove(root, { recursive: true });
  } finally {
    server.shutdown();
    core.close();
  }
});

Deno.test("default model API returns the last used model", async () => {
  const { core, server, faux, base } = await setup();
  try {
    // No sessions yet: the first enabled model is the fallback.
    const empty = await fetch(`${base}/api/sessions/default-model`);
    assertEquals(empty.status, 200);
    const fallback = await empty.json();
    assertEquals(fallback !== null, true);
    assertEquals(typeof fallback.provider, "string");
    assertEquals(typeof fallback.modelId, "string");

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
    assertEquals(sessionRes.status, 201);

    const res = await fetch(`${base}/api/sessions/default-model`);
    assertEquals(res.status, 200);
    const defaultModel = await res.json();
    assertEquals(defaultModel.provider, faux.provider.id);
    assertEquals(defaultModel.modelId, faux.getModel().id);

    await Deno.remove(root, { recursive: true });
  } finally {
    server.shutdown();
    core.close();
  }
});

Deno.test("filesystem browse API", async () => {
  const { core, server, base } = await setup();
  try {
    const rootsRes = await fetch(`${base}/api/fs/roots`);
    assertEquals(rootsRes.status, 200);
    const roots = await rootsRes.json() as string[];
    assertEquals(roots.length > 0, true, "at least one root");
    assertEquals(typeof roots[0], "string");

    // Create a nested dir structure in a temp folder and browse it.
    const root = await Deno.makeTempDir({ prefix: "lumisca-fs-" });
    const sub = `${root}/alpha`;
    await Deno.mkdir(sub, { recursive: true });
    await Deno.mkdir(`${sub}/beta`, { recursive: true });
    await Deno.writeTextFile(`${root}/file.txt`, "x");

    const browseRes = await fetch(
      `${base}/api/fs/browse?path=${encodeURIComponent(root)}`,
    );
    assertEquals(browseRes.status, 200);
    const browse = await browseRes.json();
    assertEquals(browse.path, root);
    assertEquals(
      browse.entries.some((e: { name: string }) => e.name === "alpha"),
      true,
    );
    assertEquals(
      browse.entries.some((e: { name: string }) => e.name === "file.txt"),
      false,
      "files excluded",
    );

    const nested = await fetch(
      `${base}/api/fs/browse?path=${encodeURIComponent(sub)}`,
    );
    const nestedJson = await nested.json();
    assertEquals(
      nestedJson.entries.some((e: { name: string }) => e.name === "beta"),
      true,
    );

    // Non-directory / missing path → 400.
    const fileRes = await fetch(
      `${base}/api/fs/browse?path=${encodeURIComponent(`${root}/file.txt`)}`,
    );
    assertEquals(fileRes.status, 400);
    const missing = await fetch(
      `${base}/api/fs/browse?path=${encodeURIComponent(`${root}/nope`)}`,
    );
    assertEquals(missing.status, 400);

    await Deno.remove(root, { recursive: true });
  } finally {
    server.shutdown();
    core.close();
  }
});

Deno.test("providers API includes auth state", async () => {
  const { core, server, faux, base } = await setup();
  try {
    // The faux provider always resolves auth, but only an explicit
    // credential makes it "configured".
    await core.setProviderApiKey(faux.provider.id, "test-key");
    const res = await fetch(`${base}/api/providers`);
    assertEquals(res.status, 200);
    const providers = await res.json() as Array<
      { id: string; configured: boolean; source?: string }
    >;
    assertEquals(providers.length > 0, true);
    assertEquals(typeof providers[0]!.configured, "boolean");
    const fauxEntry = providers.find((p) => p.id === faux.provider.id);
    assertEquals(fauxEntry?.configured, true);
  } finally {
    server.shutdown();
    core.close();
  }
});

Deno.test("providers API ignores ambient env keys of built-in providers", async () => {
  const { core, server, base } = await setup();
  const saved = new Map(
    ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN"]
      .map((k) => [k, Deno.env.get(k)] as const),
  );
  try {
    for (const k of saved.keys()) Deno.env.delete(k);
    Deno.env.set("ANTHROPIC_API_KEY", "sk-env-only");

    // The env key resolves (source is reported) but the provider is not
    // configured in Lumisca: it must not appear as "added".
    const res = await fetch(`${base}/api/providers`);
    assertEquals(res.status, 200);
    const providers = await res.json() as Array<
      { id: string; configured: boolean; source?: string }
    >;
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
    const after = await (await fetch(`${base}/api/providers/anthropic/auth`))
      .json() as { configured: boolean };
    assertEquals(after.configured, true);
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
    server.shutdown();
    core.close();
  }
});

Deno.test("sessions API returns 404 for unknown sessions", async () => {
  const { core, server, base } = await setup();
  try {
    const get = await fetch(`${base}/api/sessions/nope`);
    assertEquals(get.status, 404);
    assertEquals((await get.json()).error.includes("not found"), true);

    const messages = await fetch(`${base}/api/sessions/nope/messages`);
    assertEquals(messages.status, 404);

    const prompt = await json(base, "/api/sessions/nope/prompt", {
      method: "POST",
      body: JSON.stringify({ text: "hi" }),
    });
    assertEquals(prompt.status, 404);
  } finally {
    server.shutdown();
    core.close();
  }
});

Deno.test("prompt API steers a prompt sent while the session is streaming", async () => {
  const { core, server, faux, base } = await setup();
  try {
    const root = await Deno.makeTempDir({ prefix: "lumisca-srv-" });
    const create = await json(base, "/api/workspaces", {
      method: "POST",
      body: JSON.stringify({ name: "ws", folders: [root] }),
    });
    const ws = await create.json();

    faux.setResponses([
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return fauxAssistantMessage("slow");
      },
      fauxAssistantMessage("follow-up"),
    ]);
    const sessionRes = await json(base, "/api/sessions", {
      method: "POST",
      body: JSON.stringify({
        workspaceId: ws.id,
        modelProvider: faux.provider.id,
        modelId: faux.getModel().id,
      }),
    });
    const session = await sessionRes.json();

    const first = await json(base, `/api/sessions/${session.id}/prompt`, {
      method: "POST",
      body: JSON.stringify({ text: "go" }),
    });
    assertEquals(first.status, 200);

    // While the first run is streaming, a second prompt is accepted (200)
    // and steered into the running loop instead of being rejected with 409.
    const second = await json(base, `/api/sessions/${session.id}/prompt`, {
      method: "POST",
      body: JSON.stringify({ text: "again" }),
    });
    assertEquals(second.status, 200);

    await core.getAgent(session.id)!.waitForIdle();
    const userTexts = core.getAgent(session.id)!.messages
      .filter((m) => m.role === "user")
      .map((m) => (m.content[0] as { text: string }).text);
    assertEquals(userTexts, ["go", "again"]);
    await Deno.remove(root, { recursive: true });
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
    const settings = await list.json() as Record<string, string>;
    assertEquals("api_key:anthropic" in settings, false);
  } finally {
    server.shutdown();
    core.close();
  }
});

Deno.test("command safety approvals API lists, deletes and clears", async () => {
  const { core, server, base } = await setup();
  try {
    // The approvals record is a structured setting (hash + redacted display,
    // never the plaintext command); seed it like the check would write it.
    core.setSetting(
      COMMAND_SAFETY_APPROVALS_KEY,
      JSON.stringify([
        { hash: "h-npm-test", kind: "bash", cwd: "/ws/a", command: "npm test" },
        {
          hash: "h-git-status",
          kind: "bash",
          cwd: "/ws/a",
          command: "git status",
        },
      ]),
    );

    const list = await fetch(`${base}/api/settings/command-safety`);
    assertEquals(await list.json(), {
      approvals: [
        { hash: "h-npm-test", kind: "bash", cwd: "/ws/a", command: "npm test" },
        {
          hash: "h-git-status",
          kind: "bash",
          cwd: "/ws/a",
          command: "git status",
        },
      ],
    });

    // The generic settings surface never exposes the approvals record.
    const generic = await fetch(`${base}/api/settings`);
    const settings = await generic.json();
    assertEquals(settings[COMMAND_SAFETY_APPROVALS_KEY], undefined);

    const del = await json(base, "/api/settings/command-safety/approvals", {
      method: "DELETE",
      body: JSON.stringify({ hash: "h-npm-test" }),
    });
    assertEquals(del.status, 200);
    const after = await fetch(`${base}/api/settings/command-safety`);
    assertEquals(await after.json(), {
      approvals: [
        {
          hash: "h-git-status",
          kind: "bash",
          cwd: "/ws/a",
          command: "git status",
        },
      ],
    });

    // A malformed body is refused (400), and the record is untouched.
    const bad = await json(base, "/api/settings/command-safety/approvals", {
      method: "DELETE",
      body: JSON.stringify({}),
    });
    assertEquals(bad.status, 400);
    const untouched = await fetch(`${base}/api/settings/command-safety`);
    assertEquals(await untouched.json(), {
      approvals: [
        {
          hash: "h-git-status",
          kind: "bash",
          cwd: "/ws/a",
          command: "git status",
        },
      ],
    });

    const clear = await fetch(
      `${base}/api/settings/command-safety/approvals/all`,
      { method: "DELETE" },
    );
    assertEquals(clear.status, 200);
    const cleared = await fetch(`${base}/api/settings/command-safety`);
    assertEquals(await cleared.json(), { approvals: [] });
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
    const emptyInfo = await empty.json() as { path: string; content: string };
    assertEquals(emptyInfo.path, agentFile);
    assertEquals(emptyInfo.content, "");

    const put = await json(base, "/api/personalize", {
      method: "PUT",
      body: JSON.stringify({ content: "Answer in Japanese.\n" }),
    });
    assertEquals(put.status, 200);
    assertEquals(Deno.readTextFileSync(agentFile), "Answer in Japanese.\n");

    const get = await fetch(`${base}/api/personalize`);
    const info = await get.json() as { path: string; content: string };
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

Deno.test("server rejects non-loopback Host headers (DNS rebinding guard)", async () => {
  // Deno's fetch forbids overriding Host, so exercise the handler directly
  // with requests that target external hostnames.
  const faux = fauxProvider();
  const core = LumiscaCore.forTesting([faux.provider]);
  const app = createApp(core);
  try {
    const evil = await app.fetch(
      new Request("http://evil.example.com/api/health"),
    );
    assertEquals(evil.status, 403);
    const loopback = await app.fetch(
      new Request("http://127.0.0.1:8000/api/health", {
        headers: { host: "127.0.0.1:8000" },
      }),
    );
    assertEquals(loopback.status, 200);
  } finally {
    core.close();
  }
});

Deno.test("cors only allows same-origin and the tauri webview origin", async () => {
  const { core, server, base } = await setup();
  try {
    const evil = await fetch(`${base}/api/health`, {
      headers: { Origin: "https://evil.example.com" },
    });
    assertEquals(
      evil.headers.get("access-control-allow-origin"),
      null,
      "cross-origin reads must be blocked",
    );

    const tauri = await fetch(`${base}/api/health`, {
      headers: { Origin: "tauri://localhost" },
    });
    assertEquals(
      tauri.headers.get("access-control-allow-origin"),
      "tauri://localhost",
    );

    const same = await fetch(`${base}/api/health`, {
      headers: { Origin: base },
    });
    assertEquals(same.headers.get("access-control-allow-origin"), base);
  } finally {
    server.shutdown();
    core.close();
  }
});

Deno.test("cors and websocket reject other local ports (full-origin check)", async () => {
  const { core, server, base } = await setup();
  try {
    // Same host, different port: must be treated as cross-origin.
    const otherPort = base.replace(/:\d+$/, ":3000");
    const res = await fetch(`${base}/api/health`, {
      headers: { Origin: otherPort },
    });
    assertEquals(
      res.headers.get("access-control-allow-origin"),
      null,
      "a different local port must not pass the origin check",
    );

    // localhost vs 127.0.0.1 on the SAME port: allowed (same server).
    const nameVariant = base.replace("127.0.0.1", "localhost");
    const samePort = await fetch(`${base}/api/health`, {
      headers: { Origin: nameVariant },
    });
    assertEquals(
      samePort.headers.get("access-control-allow-origin"),
      nameVariant,
      "loopback name variants on the same port are the same server",
    );
  } finally {
    server.shutdown();
    core.close();
  }
});

Deno.test("websocket rejects cross-port origins", async () => {
  const faux = fauxProvider();
  const core = LumiscaCore.forTesting([faux.provider]);
  const app = createApp(core);
  try {
    const crossPort = await app.fetch(
      new Request("http://127.0.0.1:8000/ws", {
        headers: { origin: "http://127.0.0.1:3000" },
      }),
    );
    assertEquals(crossPort.status, 403, "cross-port WS must be rejected");
  } finally {
    core.close();
  }
});

Deno.test("token auth guards the API, websocket and page", async () => {
  const faux = fauxProvider();
  const core = LumiscaCore.forTesting([faux.provider]);
  const app = createApp(core, { token: "secret-token" });
  // `new Request(...)` does not add a Host header; the loopback Host guard
  // needs one, so every probe sets it explicitly.
  const HOST = { host: "127.0.0.1:8000" };
  try {
    // Without the token: 401.
    const denied = await app.fetch(
      new Request("http://127.0.0.1:8000/api/health", { headers: HOST }),
    );
    assertEquals(denied.status, 401);

    // Wrong token: 401.
    const wrong = await app.fetch(
      new Request("http://127.0.0.1:8000/api/health", {
        headers: { ...HOST, "x-lumisca-token": "nope" },
      }),
    );
    assertEquals(wrong.status, 401);

    // Correct header: allowed.
    const ok = await app.fetch(
      new Request("http://127.0.0.1:8000/api/health", {
        headers: { ...HOST, "x-lumisca-token": "secret-token" },
      }),
    );
    assertEquals(ok.status, 200);

    // WS: query parameter token (browsers cannot set WS headers).
    const wsDenied = await app.fetch(
      new Request("http://127.0.0.1:8000/ws", { headers: HOST }),
    );
    assertEquals(wsDenied.status, 401);
    // With the token the guard passes; the upgrade itself does not complete
    // without websocket headers, so assert only that it is not the guard's
    // 401/403.
    const wsOk = await app.fetch(
      new Request("http://127.0.0.1:8000/ws?token=secret-token", {
        headers: HOST,
      }),
    );
    assertEquals(wsOk.status !== 401 && wsOk.status !== 403, true);

    // The page itself is guarded too (the token is a real capability).
    const pageDenied = await app.fetch(
      new Request("http://127.0.0.1:8000/", { headers: HOST }),
    );
    assertEquals(pageDenied.status, 401);

    // With `?token=` the page renders; the externalized initial-data script
    // (inline scripts are banned by the page CSP) carries the token in its
    // URL so the guarded asset can be fetched.
    const page = await app.fetch(
      new Request("http://127.0.0.1:8000/?token=secret-token", {
        headers: HOST,
      }),
    );
    const html = await page.text();
    assertEquals(
      html.includes('src="/assets/initial-data.js?token=secret-token"'),
      true,
    );

    const dataDenied = await app.fetch(
      new Request("http://127.0.0.1:8000/assets/initial-data.js", {
        headers: HOST,
      }),
    );
    assertEquals(dataDenied.status, 401);

    const dataScript = await app.fetch(
      new Request(
        "http://127.0.0.1:8000/assets/initial-data.js?token=secret-token",
        { headers: HOST },
      ),
    );
    const script = await dataScript.text();
    assertEquals(
      script.includes('window.__LUMISCA_TOKEN__ = "secret-token"'),
      true,
    );
  } finally {
    core.close();
  }
});

Deno.test("host guard rejects non-loopback hosts by default", async () => {
  const faux = fauxProvider();
  const core = LumiscaCore.forTesting([faux.provider]);
  const app = createApp(core);
  try {
    const remote = await app.fetch(
      new Request("http://127.0.0.1:8000/api/health", {
        headers: { host: "myserver.tailnet.ts.net:8000" },
      }),
    );
    assertEquals(remote.status, 403);
    // Loopback spellings keep working.
    for (const host of ["127.0.0.1:8000", "localhost:8000", "[::1]:8000"]) {
      const ok = await app.fetch(
        new Request("http://127.0.0.1:8000/api/health", {
          headers: { host },
        }),
      );
      assertEquals(ok.status, 200, `host ${host} must be allowed`);
    }
  } finally {
    core.close();
  }
});

Deno.test("host guard accepts LUMISCA_ALLOWED_HOSTS", async () => {
  const faux = fauxProvider();
  const core = LumiscaCore.forTesting([faux.provider]);
  const app = createApp(core, {
    allowedHosts: ["myserver.tailnet.ts.net", "192.168.1.20"],
  });
  try {
    const ok = await app.fetch(
      new Request("http://127.0.0.1:8000/api/health", {
        headers: { host: "myserver.tailnet.ts.net:8000" },
      }),
    );
    assertEquals(ok.status, 200);

    // Hostnames are case-insensitive.
    const mixed = await app.fetch(
      new Request("http://127.0.0.1:8000/api/health", {
        headers: { host: "MyServer.Tailnet.Ts.Net:8000" },
      }),
    );
    assertEquals(mixed.status, 200);

    // The WebSocket guard passes for allowed hosts too (the upgrade itself
    // fails without websocket headers — but not with the host 403).
    const ws = await app.fetch(
      new Request("http://127.0.0.1:8000/ws", {
        headers: { host: "192.168.1.20:8000" },
      }),
    );
    assertEquals(ws.status !== 403, true);

    // Anything not listed stays blocked.
    const other = await app.fetch(
      new Request("http://127.0.0.1:8000/api/health", {
        headers: { host: "other.example.com:8000" },
      }),
    );
    assertEquals(other.status, 403);
  } finally {
    core.close();
  }
});

Deno.test("validateHostConfig requires a token for non-loopback binds", () => {
  assertEquals(validateHostConfig("127.0.0.1", undefined), null);
  assertEquals(validateHostConfig("localhost", undefined), null);
  assertEquals(validateHostConfig("::1", undefined), null);
  assertEquals(validateHostConfig("0.0.0.0", undefined) !== null, true);
  assertEquals(validateHostConfig("0.0.0.0", "token"), null);
  assertEquals(validateHostConfig("100.64.0.5", undefined) !== null, true);
  assertEquals(validateHostConfig("100.64.0.5", "token"), null);
  assertEquals(isLoopbackHost("127.0.0.1"), true);
  assertEquals(isLoopbackHost("localhost"), true);
  assertEquals(isLoopbackHost("::1"), true);
  assertEquals(isLoopbackHost("0.0.0.0"), false);
  assertEquals(isLoopbackHost("100.64.0.5"), false);
});

Deno.test("settings API never exposes credentials", async () => {
  const { core, server, base } = await setup();
  try {
    await core.setProviderApiKey("anthropic", "sk-secret-test-123");
    const res = await fetch(`${base}/api/settings`);
    assertEquals(res.status, 200);
    const settings = await res.json() as Record<string, string>;
    assertEquals(
      Object.keys(settings).some((k) => k.includes("api_key")),
      false,
    );
    assertEquals(
      Object.values(settings).includes("sk-secret-test-123"),
      false,
    );
  } finally {
    server.shutdown();
    core.close();
  }
});

Deno.test("connections API: registry roundtrip, validation and protection", async () => {
  const { core, server, base } = await setup();
  try {
    // Starts empty.
    const empty = await fetch(`${base}/api/connections`);
    assertEquals(empty.status, 200);
    assertEquals((await empty.json()).connections.length, 0);

    // PUT the whole registry.
    const entries = [
      { id: "srv-1", name: "自宅", url: "http://100.64.0.5:8000", token: "t1" },
      {
        id: "srv-2",
        name: "作業PC",
        url: "http://192.168.1.20:8000",
        token: "",
      },
    ];
    const put = await json(base, "/api/connections", {
      method: "PUT",
      body: JSON.stringify({ connections: entries }),
    });
    assertEquals(put.status, 200);

    const got = await fetch(`${base}/api/connections`);
    const body = await got.json() as { connections: typeof entries };
    assertEquals(body.connections.length, 2);
    assertEquals(body.connections[1]?.name, "作業PC");

    // Malformed bodies are rejected, not persisted.
    const bad = await json(base, "/api/connections", {
      method: "PUT",
      body: JSON.stringify({ connections: [{ id: "x", name: 42 }] }),
    });
    assertEquals(bad.status, 400);
    const after = await fetch(`${base}/api/connections`);
    assertEquals((await after.json()).connections.length, 2);

    // The registry holds tokens: it must not leak via generic settings,
    // and the generic settings API refuses to touch it.
    const settings = await fetch(`${base}/api/settings`);
    const values = Object.values(
      await settings.json() as Record<string, string>,
    );
    assertEquals(values.some((v) => v.includes("srv-1")), false);
    assertEquals(values.some((v) => v.includes("t1")), false);
    const forbidden = await json(base, "/api/settings/connections", {
      method: "PUT",
      body: JSON.stringify({ value: "x" }),
    });
    assertEquals(forbidden.status, 403);
  } finally {
    server.shutdown();
    core.close();
  }
});

Deno.test("federation: hub merges peers and proxies workspaces and sessions", async () => {
  // Peer first: the hub's federation client connects to it at startup.
  const peerFaux = fauxProvider();
  const peerCore = LumiscaCore.forTesting([peerFaux.provider]);
  const peerServer = startServer(peerCore, 0, { token: "peer-token" });
  const peerBase = `http://127.0.0.1:${peerServer.addr.port}`;
  let peerRoot = "";
  try {
    peerRoot = await Deno.makeTempDir({ prefix: "lumisca-peer-" });
    const peerWsRes = await json(peerBase, "/api/workspaces", {
      method: "POST",
      body: JSON.stringify({ name: "peer-ws", folders: [peerRoot] }),
      headers: { "x-lumisca-token": "peer-token" },
    });
    assertEquals(peerWsRes.status, 201);

    // Hub with the peer (and itself, to prove the self-guard) registered.
    // Connections must be set BEFORE the server starts: the federation
    // client connects to peers once the listener is bound.
    const hubFaux = fauxProvider();
    const hubCore = LumiscaCore.forTesting([hubFaux.provider]);
    hubCore.setConnections([
      { id: "peer1", name: "自宅", url: peerBase, token: "peer-token" },
      // Registering the hub itself must be ignored (event loop guard).
      // The hub's own URL is filled in below once its port is known.
    ]);
    const hubServer = startServer(hubCore, 0, { token: "hub-token" });
    const hubBase = `http://127.0.0.1:${hubServer.addr.port}`;
    hubCore.setConnections([
      { id: "peer1", name: "自宅", url: peerBase, token: "peer-token" },
      { id: "self", name: "self", url: hubBase, token: "hub-token" },
    ]);
    try {
      const auth = { "x-lumisca-token": "hub-token" };
      const hubRoot = await Deno.makeTempDir({ prefix: "lumisca-hub-" });
      await json(hubBase, "/api/workspaces", {
        method: "POST",
        body: JSON.stringify({ name: "hub-ws", folders: [hubRoot] }),
        headers: auth,
      });

      // Merged workspace list: hub + peer, self excluded.
      const mergedRes = await json(hubBase, "/api/fed/workspaces", {
        headers: auth,
      });
      assertEquals(mergedRes.status, 200);
      const merged = await mergedRes.json() as {
        workspaces: Array<{
          peerId: string;
          peerName: string;
          workspace: { id: string; name: string };
        }>;
        peers: Array<{ id: string; name: string; ok: boolean; error?: string }>;
      };
      assertEquals(merged.workspaces.length, 2);
      const hubEntry = merged.workspaces.find((w) => w.peerId === "");
      const peerEntry = merged.workspaces.find((w) => w.peerId === "peer1");
      assertEquals(hubEntry?.workspace.name, "hub-ws");
      assertEquals(peerEntry?.workspace.name, "peer-ws");
      assertEquals(peerEntry?.peerName, "自宅");
      assertEquals(merged.peers.length, 1);
      assertEquals(merged.peers[0]?.ok, true);

      // Create a workspace on the peer through the hub.
      const remoteCreate = await json(hubBase, "/api/fed/peer1/workspaces", {
        method: "POST",
        body: JSON.stringify({ name: "peer-ws-2", folders: [peerRoot] }),
        headers: auth,
      });
      assertEquals(remoteCreate.status, 201);

      // Rename it through the hub (PATCH).
      const remotePatch = await json(
        hubBase,
        `/api/fed/peer1/workspaces/${(await remoteCreate.json()).id}`,
        {
          method: "PATCH",
          body: JSON.stringify({ name: "peer-ws-2-renamed" }),
          headers: auth,
        },
      );
      assertEquals(remotePatch.status, 200);
      assertEquals((await remotePatch.json()).name, "peer-ws-2-renamed");

      // Open the hub WS first so we can watch peer events arrive.
      const hubWs = new WebSocket(
        `${hubBase.replace("http", "ws")}/ws?token=hub-token`,
      );
      const fedEvents: Array<{ peerId: string; type: string }> = [];
      hubWs.onmessage = (evt) => {
        const event = JSON.parse(String(evt.data));
        if (event.peerId === "peer1") fedEvents.push(event);
      };
      await new Promise<void>((resolve) => (hubWs.onopen = () => resolve()));

      // Session + prompt roundtrip on the peer through the hub. The model
      // is explicit: the default-model fallback would resolve to the
      // first builtin provider (unconfigured on CI), which used to pass
      // here only because the assertions never looked at the content.
      const peerWorkspaceId = peerEntry?.workspace.id;
      assertEquals(typeof peerWorkspaceId, "string");
      peerFaux.setResponses([fauxAssistantMessage("Hi from peer!")]);
      const created = await json(hubBase, "/api/fed/peer1/sessions", {
        method: "POST",
        body: JSON.stringify({
          workspaceId: peerWorkspaceId,
          name: "fed",
          modelProvider: peerFaux.provider.id,
          modelId: peerFaux.getModel().id,
        }),
        headers: auth,
      });
      assertEquals(created.status, 201);
      const session = await created.json();

      const prompt = await json(
        hubBase,
        `/api/fed/peer1/sessions/${session.id}/prompt`,
        {
          method: "POST",
          body: JSON.stringify({ text: "hello" }),
          headers: auth,
        },
      );
      assertEquals(prompt.status, 200);

      // The peer's agent events arrive at the hub's UI websocket, tagged
      // with the peer id.
      const deadline = Date.now() + 5000;
      while (
        !fedEvents.some((e) => e.type === "agent_end") &&
        Date.now() < deadline
      ) {
        await new Promise((r) => setTimeout(r, 50));
      }
      assertEquals(
        fedEvents.some((e) => e.type === "agent_end"),
        true,
        "peer events must be relayed with the peer id",
      );

      const messages = await json(
        hubBase,
        `/api/fed/peer1/sessions/${session.id}/messages`,
        { headers: auth },
      );
      const msgs = await messages.json();
      assertEquals(msgs.length, 2);
      assertEquals(msgs[1].role, "assistant");
      assertEquals(
        msgs[1].content[0].text,
        "Hi from peer!",
        "the peer's prompt roundtrip must produce the real answer",
      );

      // Unknown peer → 404.
      const unknown = await json(hubBase, "/api/fed/nope/workspaces", {
        headers: auth,
      });
      assertEquals(unknown.status, 404);
      hubWs.close();
      await Deno.remove(hubRoot, { recursive: true });
    } finally {
      disposeServer(hubServer);
      hubServer.shutdown();
      hubCore.close();
    }
    // The peer is gone: a fresh hub must answer 502 for it.
    disposeServer(peerServer);
    peerServer.shutdown();
    peerCore.close();
    const deadHubCore = LumiscaCore.forTesting([hubFaux.provider]);
    deadHubCore.setConnections([
      { id: "peer1", name: "自宅", url: peerBase, token: "peer-token" },
    ]);
    const deadHub = startServer(deadHubCore, 0, { token: "hub-token" });
    try {
      const res = await json(
        `http://127.0.0.1:${deadHub.addr.port}`,
        "/api/fed/peer1/fs/roots",
        { headers: { "x-lumisca-token": "hub-token" } },
      );
      assertEquals(res.status, 502);
    } finally {
      disposeServer(deadHub);
      deadHub.shutdown();
      deadHubCore.close();
    }
  } finally {
    if (peerRoot !== "") {
      await Deno.remove(peerRoot, { recursive: true }).catch(() => {});
    }
  }
});

Deno.test("websocket rejects cross-origin connections", async () => {
  const faux = fauxProvider();
  const core = LumiscaCore.forTesting([faux.provider]);
  const app = createApp(core);
  try {
    // A malicious website's WS handshake must be refused before the upgrade.
    const evil = await app.fetch(
      new Request("http://127.0.0.1:8000/ws", {
        headers: {
          host: "127.0.0.1:8000",
          origin: "https://evil.example.com",
        },
      }),
    );
    assertEquals(evil.status, 403);

    // Same-origin browsers pass the guard (the upgrade itself fails here
    // without websocket headers — but not with the guard's 403).
    const same = await app.fetch(
      new Request("http://127.0.0.1:8000/ws", {
        headers: { host: "127.0.0.1:8000", origin: "http://127.0.0.1:8000" },
      }),
    );
    assertEquals(
      same.status !== 403,
      true,
      "same-origin must pass the origin guard",
    );
  } finally {
    core.close();
  }
});

Deno.test("unknown static assets return 404, not the HTML shell", async () => {
  const faux = fauxProvider();
  const core = LumiscaCore.forTesting([faux.provider]);
  const server = startServer(core, 0, { repoRoot: Deno.cwd() });
  try {
    const base = `http://127.0.0.1:${server.addr.port}`;
    const favicon = await fetch(`${base}/favicon.ico`);
    assertEquals(favicon.status, 404);
    const png = await fetch(`${base}/favicon.png`);
    assertEquals(png.status, 200);
    assertEquals(png.headers.get("content-type"), "image/png");
    assertEquals((await png.arrayBuffer()).byteLength > 0, true);
    const stale = await fetch(`${base}/assets/app.deadbeef.js`);
    assertEquals(stale.status, 404);
    const content = await stale.text();
    assertEquals(content.includes("__INITIAL_DATA__"), false);
  } finally {
    server.shutdown();
    core.close();
  }
});

function joinMissing(): string {
  return `Z:\\definitely\\not\\here\\lumisca-${crypto.randomUUID()}`;
}

Deno.test("server serves the app shell", async () => {
  const faux = fauxProvider();
  const core = LumiscaCore.forTesting([faux.provider]);
  const server = startServer(core, 0, { repoRoot: Deno.cwd() });
  try {
    const base = `http://127.0.0.1:${server.addr.port}`;
    const index = await fetch(`${base}/`);
    assertEquals(index.status, 200);
    const html = await index.text();
    // Static shell: an empty #root (the app renders client-side), the
    // externalized initial data (inline scripts are banned by the page
    // CSP), and the client bundle script.
    assertEquals(html.includes('<div id="root"></div>'), true);
    assertEquals(html.includes('src="/assets/initial-data.js"'), true);
    assertEquals(html.includes('src="/assets/app.js"'), true);
    assertEquals(html.includes("styles.css") || html.includes("<style>"), true);
    // The desktop shell bridge (settings → 接続先サーバー) is allowed by
    // the CSP; in plain browsers that host does not resolve.
    assertEquals(html.includes("http://lumisca.localhost"), true);

    // The initial-data script carries the serialized state.
    const dataScript = await fetch(`${base}/assets/initial-data.js`);
    assertEquals(dataScript.status, 200);
    assertEquals(
      (await dataScript.text()).includes("window.__INITIAL_DATA__"),
      true,
    );

    // SPA fallback renders the same shell.
    const fallback = await fetch(`${base}/some/route`);
    assertEquals(fallback.status, 200);
    assertEquals((await fallback.text()).includes('id="root"'), true);

    // API must not be shadowed.
    const health = await fetch(`${base}/api/health`);
    assertEquals(health.status, 200);
    assertEquals((await health.json()).ok, true);
  } finally {
    server.shutdown();
    core.close();
  }
});

Deno.test("server bundles and serves the client app", async () => {
  const faux = fauxProvider();
  const core = LumiscaCore.forTesting([faux.provider]);
  const server = startServer(core, 0, { repoRoot: Deno.cwd() });
  try {
    const base = `http://127.0.0.1:${server.addr.port}`;
    const res = await fetch(`${base}/assets/app.js`);
    assertEquals(res.status, 200);
    const js = await res.text();
    assertEquals(js.length > 10_000, true, "bundle should include react");
    assertEquals(js.includes("createRoot"), true);
  } finally {
    server.shutdown();
    core.close();
  }
});

Deno.test("MCP config API: get, put, validate and rebuild sessions", async () => {
  const { core, server, base, faux } = await setup();
  const providerId = faux.provider.id;
  const modelId = faux.getModel().id;
  let root = "";
  try {
    root = await Deno.makeTempDir({ prefix: "lumisca-srv-" });
    const fakeServer = join(
      import.meta.dirname!,
      "..",
      "..",
      "scripts",
      "fake-mcp-server.ts",
    );
    const create = await json(base, "/api/workspaces", {
      method: "POST",
      body: JSON.stringify({ name: "ws", folders: [root] }),
    });
    const ws = await create.json();

    // No .mcp.json yet: empty config, no file.
    const empty = await json(base, `/api/workspaces/${ws.id}/mcp`);
    assertEquals(empty.status, 200);
    const emptyInfo = await empty.json();
    assertEquals(emptyInfo.servers.length, 0);
    assertEquals(emptyInfo.exists, false);

    // A session exists before the config is saved; PUT must rebuild it.
    const session = core.createSession({
      workspaceId: ws.id,
      name: "mcp",
      modelProvider: providerId,
      modelId,
    });

    const put = await json(base, `/api/workspaces/${ws.id}/mcp`, {
      method: "PUT",
      body: JSON.stringify({
        mcpServers: {
          fake: { command: Deno.execPath(), args: ["run", fakeServer] },
          disabled: { command: "nope", enabled: false },
        },
      }),
    });
    assertEquals(put.status, 200);
    const info = await put.json();
    assertEquals(info.exists, true);
    assertEquals(info.servers.length, 2);
    assertEquals(info.servers[0]!.name, "fake");
    assertEquals(info.servers[0]!.type, "stdio");
    assertEquals(info.servers[1]!.enabled, false);

    // The file was written; GET reflects it.
    const again = await json(base, `/api/workspaces/${ws.id}/mcp`);
    const againInfo = await again.json();
    assertEquals(againInfo.servers.length, 2);

    // The rebuilt session attaches the search/call pair asynchronously —
    // the MCP definitions themselves stay out of the agent tool set.
    const agent = core.getAgent(session.id)!;
    const started = Date.now();
    while (
      !agent.agent.state.tools.some((t) => t.name === "tool_search") &&
      Date.now() - started < 10000
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assertEquals(
      agent.agent.state.tools.some((t) => t.name === "tool_search") &&
        agent.agent.state.tools.some((t) => t.name === "tool_call"),
      true,
      "session must attach the search/call pair after PUT",
    );
    assertEquals(
      agent.agent.state.tools.some((t) => t.name.startsWith("mcp__")),
      false,
      "MCP definitions must stay out of the agent tool set",
    );
    // The disabled server contributes no tools.
    assertEquals(
      agent.agent.state.tools.some((t) => t.name === "mcp__disabled__"),
      false,
    );
  } finally {
    server.shutdown();
    core.close();
    // The MCP server process must be dead before the dir can go.
    await removeDirRetry(root);
  }
});

Deno.test("MCP config API rejects invalid input", async () => {
  const { core, server, base } = await setup();
  let root = "";
  try {
    root = await Deno.makeTempDir({ prefix: "lumisca-srv-" });
    const create = await json(base, "/api/workspaces", {
      method: "POST",
      body: JSON.stringify({ name: "ws", folders: [root] }),
    });
    const ws = await create.json();

    const invalid = await json(base, `/api/workspaces/${ws.id}/mcp`, {
      method: "PUT",
      body: "not json",
    });
    assertEquals(invalid.status, 400);

    const emptyBody = await json(base, `/api/workspaces/${ws.id}/mcp`, {
      method: "PUT",
      body: "",
    });
    assertEquals(emptyBody.status, 400);

    const missingWorkspace = await json(base, "/api/workspaces/nope/mcp");
    assertEquals(missingWorkspace.status, 404);

    // Nothing was written by the failed requests.
    const after = await json(base, `/api/workspaces/${ws.id}/mcp`);
    assertEquals((await after.json()).exists, false);

    await Deno.remove(root, { recursive: true });
  } finally {
    server.shutdown();
    core.close();
  }
});

Deno.test("app-level MCP config API applies to every workspace", async () => {
  const { core, server, base, faux } = await setup();
  const providerId = faux.provider.id;
  const modelId = faux.getModel().id;
  let root = "";
  try {
    const fakeServer = join(
      import.meta.dirname!,
      "..",
      "..",
      "scripts",
      "fake-mcp-server.ts",
    );
    // No app config yet.
    const empty = await json(base, "/api/mcp");
    assertEquals(empty.status, 200);
    assertEquals((await empty.json()).servers.length, 0);

    // Save an app-level server.
    const put = await json(base, "/api/mcp", {
      method: "PUT",
      body: JSON.stringify({
        mcpServers: {
          fake: { command: Deno.execPath(), args: ["run", fakeServer] },
        },
      }),
    });
    assertEquals(put.status, 200);
    const info = await put.json();
    assertEquals(info.servers.length, 1);
    assertEquals(info.servers[0]!.name, "fake");

    const invalid = await json(base, "/api/mcp", {
      method: "PUT",
      body: "nope",
    });
    assertEquals(invalid.status, 400);

    // A session in any workspace picks up the app-level tools (as the
    // search/call pair over the registry).
    root = await Deno.makeTempDir({ prefix: "lumisca-srv-" });
    const create = await json(base, "/api/workspaces", {
      method: "POST",
      body: JSON.stringify({ name: "ws", folders: [root] }),
    });
    const ws = await create.json();
    const session = core.createSession({
      workspaceId: ws.id,
      name: "app-mcp",
      modelProvider: providerId,
      modelId,
    });
    const agent = core.getAgent(session.id)!;
    const started = Date.now();
    while (
      !agent.agent.state.tools.some((t) => t.name === "tool_search") &&
      Date.now() - started < 10000
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assertEquals(
      agent.agent.state.tools.some((t) => t.name === "tool_search") &&
        agent.agent.state.tools.some((t) => t.name === "tool_call"),
      true,
      "session must attach the search/call pair for app-level MCP tools",
    );
    assertEquals(
      agent.agent.state.tools.some((t) => t.name.startsWith("mcp__")),
      false,
      "MCP definitions must stay out of the agent tool set",
    );
  } finally {
    server.shutdown();
    core.close();
    if (root) await removeDirRetry(root);
  }
});

Deno.test("todo API returns the session's current plan", async () => {
  const { core, server, faux, base } = await setup();
  let root: string | undefined;
  try {
    root = await Deno.makeTempDir({ prefix: "lumisca-srv-" });
    const create = await json(base, "/api/workspaces", {
      method: "POST",
      body: JSON.stringify({ name: "ws", folders: [root] }),
    });
    const ws = await create.json();
    const created = await json(base, "/api/sessions", {
      method: "POST",
      body: JSON.stringify({
        workspaceId: ws.id,
        // The faux provider's default model is not the faux one; pick the
        // tool-calling model explicitly (same as the core tests).
        modelProvider: faux.provider.id,
        modelId: faux.getModel().id,
      }),
    });
    const session = await created.json();

    // No plan yet: the endpoint returns an empty list (and opens the session).
    const empty = await json(base, `/api/sessions/${session.id}/todo`);
    assertEquals(empty.status, 200);
    assertEquals((await empty.json()).todos, []);

    // Drive a run that plans a todo list via the tool.
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("todo", {
          action: "plan",
          phases: [{ name: "実装", tasks: ["調査する", "実装する"] }],
        }),
      ]),
      fauxAssistantMessage("planned"),
    ]);
    await core.prompt(session.id, "Plan the work");

    const res = await json(base, `/api/sessions/${session.id}/todo`);
    const { todos } = await res.json() as { todos: TodoPhase[] };
    assertEquals(todos.length, 1);
    assertEquals(todos[0]!.name, "実装");
    assertEquals(
      todos[0]!.tasks.map((t) => [t.name, t.status]),
      [
        ["調査する", "pending"],
        ["実装する", "pending"],
      ],
    );

    // Unknown sessions 404.
    const missing = await json(base, "/api/sessions/nope/todo");
    assertEquals(missing.status, 404);
  } finally {
    server.shutdown();
    core.close();
    if (root) await removeDirRetry(root);
  }
});
