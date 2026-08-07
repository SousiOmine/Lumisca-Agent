import { realpathSync } from "node:fs";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { assertEquals } from "@std/assert";
import { LumiscaCore } from "@lumisca/core";
import { createApp, startServer } from "./app.ts";
function setup() {
  const faux = fauxProvider();
  const core = LumiscaCore.forTesting([faux.provider]);
  const server = startServer(core, 0);
  const port = server.addr.port;
  const base = `http://127.0.0.1:${port}`;
  return { core, server, faux, base };
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
    const res = await fetch(`${base}/api/providers`);
    assertEquals(res.status, 200);
    const providers = await res.json() as Array<
      { id: string; configured: boolean; source?: string }
    >;
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

Deno.test("prompt API rejects while the session is streaming", async () => {
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

    const second = await json(base, `/api/sessions/${session.id}/prompt`, {
      method: "POST",
      body: JSON.stringify({ text: "again" }),
    });
    assertEquals(second.status, 409);
    assertEquals((await second.json()).error.includes("already running"), true);

    await core.getAgent(session.id)!.waitForIdle();
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
    // Nothing was stored (checked at the DB layer; the generic settings
    // surface refuses to read credential keys back).
    const row = core.db.db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get("api_key:anthropic") as { value: string } | undefined;
    assertEquals(row, undefined);
  } finally {
    server.shutdown();
    core.close();
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

Deno.test("token auth guards the API and websocket when configured", async () => {
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

    // The SSR page embeds the token via the externalized initial-data
    // script (inline scripts are banned by the page CSP).
    const page = await app.fetch(
      new Request("http://127.0.0.1:8000/", { headers: HOST }),
    );
    const html = await page.text();
    assertEquals(html.includes('src="/assets/initial-data.js"'), true);
    const dataScript = await app.fetch(
      new Request("http://127.0.0.1:8000/assets/initial-data.js", {
        headers: HOST,
      }),
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

Deno.test("server SSR-renders the app shell", async () => {
  const faux = fauxProvider();
  const core = LumiscaCore.forTesting([faux.provider]);
  const server = startServer(core, 0, { repoRoot: Deno.cwd() });
  try {
    const base = `http://127.0.0.1:${server.addr.port}`;
    const index = await fetch(`${base}/`);
    assertEquals(index.status, 200);
    const html = await index.text();
    // Server-rendered markup, externalized initial data (inline scripts are
    // banned by the page CSP), and the hydration script.
    assertEquals(html.includes('<div id="root">'), true);
    assertEquals(html.includes('src="/assets/initial-data.js"'), true);
    assertEquals(html.includes('src="/assets/app.js"'), true);
    assertEquals(html.includes("styles.css") || html.includes("<style>"), true);

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
    assertEquals(js.includes("hydrateRoot"), true);
  } finally {
    server.shutdown();
    core.close();
  }
});
