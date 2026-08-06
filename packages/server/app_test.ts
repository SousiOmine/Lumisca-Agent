import { realpathSync } from "node:fs";
import {
  fauxAssistantMessage,
  fauxProvider,
} from "npm:@earendil-works/pi-ai@0.83.0";
import { assertEquals } from "jsr:@std/assert";
import { LumiscaCore } from "@lumisca/core";
import { startServer } from "./app.ts";
async function setup() {
  const faux = fauxProvider();
  const core = LumiscaCore.forTesting([faux.provider]);
  const server = startServer(core, 0);
  const port = server.addr.port;
  const base = `http://127.0.0.1:${port}`;
  return { core, server, faux, base };
}

function json(base: string, path: string, init?: RequestInit): Promise<Response> {
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

    const messagesRes = await json(base, `/api/sessions/${session.id}/messages`);
    const messages = await messagesRes.json();
    assertEquals(messages.length, 2);
    assertEquals(messages[1].role, "assistant");

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
    const modelsRes = await fetch(`${base}/api/providers/${faux.provider.id}/models`);
    assertEquals(modelsRes.status, 200);
    const models = await modelsRes.json() as Array<{ id: string; enabled: boolean }>;
    assertEquals(models.length > 0, true);
    assertEquals(models.every((m) => m.enabled === true), true, "default enabled");

    const target = models[0]!;
    const put = await fetch(
      `${base}/api/providers/${faux.provider.id}/models/${encodeURIComponent(target.id)}`,
      { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: false }) },
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
      body: JSON.stringify({ provider: faux.provider.id, modelId: faux.getModel().id }),
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

    const browseRes = await fetch(`${base}/api/fs/browse?path=${encodeURIComponent(root)}`);
    assertEquals(browseRes.status, 200);
    const browse = await browseRes.json();
    assertEquals(browse.path, root);
    assertEquals(browse.entries.some((e: { name: string }) => e.name === "alpha"), true);
    assertEquals(browse.entries.some((e: { name: string }) => e.name === "file.txt"), false, "files excluded");

    const nested = await fetch(`${base}/api/fs/browse?path=${encodeURIComponent(sub)}`);
    const nestedJson = await nested.json();
    assertEquals(nestedJson.entries.some((e: { name: string }) => e.name === "beta"), true);

    // Non-directory / missing path → 400.
    const fileRes = await fetch(`${base}/api/fs/browse?path=${encodeURIComponent(`${root}/file.txt`)}`);
    assertEquals(fileRes.status, 400);
    const missing = await fetch(`${base}/api/fs/browse?path=${encodeURIComponent(`${root}/nope`)}`);
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
    const res = await fetch(`${base}/api/providers`);
    assertEquals(res.status, 200);
    const providers = await res.json() as Array<{ id: string; configured: boolean; source?: string }>;
    assertEquals(providers.length > 0, true);
    assertEquals(typeof providers[0]!.configured, "boolean");
    // The faux provider always resolves auth → configured.
    const fauxEntry = providers.find((p) => p.id === faux.provider.id);
    assertEquals(fauxEntry?.configured, true);
  } finally {
    server.shutdown();
    core.close();
  }
});

function joinMissing(): string {
  return `Z:\\definitely\\not\\here\\lumisca-${crypto.randomUUID()}`;
}

Deno.test("server SSR-renders the app shell", async () => {
  const faux = fauxProvider();
  const core = LumiscaCore.forTesting([faux.provider]);
  const server = startServer(core, 0, { repoRoot: Deno.cwd() });
  try {
    const base = `http://127.0.0.1:${server.addr.port}`;
    const index = await fetch(`${base}/`);
    assertEquals(index.status, 200);
    const html = await index.text();
    // Server-rendered markup, initial data, and the hydration script.
    assertEquals(html.includes('<div id="root">'), true);
    assertEquals(html.includes("__INITIAL_DATA__"), true);
    assertEquals(html.includes("/assets/app.js"), true);
    assertEquals(html.includes("styles.css") || html.includes("<style>"), true);

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
    assertEquals(js.includes("hydrateRoot"), true);
  } finally {
    server.shutdown();
    core.close();
  }
});
