import { join } from "node:path";

import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@lumisca/core";
import { assert, assertEquals } from "@std/assert";
import { LumiscaCore, type TodoPhase } from "@lumisca/core";

import { type AppOptions, disposeServer, startServer } from "./app.ts";

import { removeDirRetry } from "@lumisca/core/test-utils";

function setup(
  env?: () => Record<string, string>,
  options?: AppOptions,
) {
  const faux = fauxProvider();
  const core = LumiscaCore.forTesting([faux.provider], env);
  const server = startServer(core, 0, options);
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

/** The transcript without the dynamic-context publications (skill catalog,
 * instructions, date, on-demand tools) a session publishes ahead of the
 * first user message of a run. Those are not part of a turn, so the tests
 * that count or position turns count this array. */

/** The transcript without the dynamic-context publications (skill catalog,
 * instructions, date, on-demand tools) a session publishes ahead of the
 * first user message of a run. Those are not part of a turn, so the tests
 * that count or position turns count this array. */
function conversationOf<T extends { role: string }>(messages: T[]): T[] {
  return messages.filter((m) => m.role !== "context");
}

/** The base64 body an icon upload takes: the same bytes the store's tests
 * use, in the shape a browser's `FileReader` produces (minus the data-URL
 * header, which the route also accepts). */

/** The base64 body an icon upload takes: the same bytes the store's tests
 * use, in the shape a browser's `FileReader` produces (minus the data-URL
 * header, which the route also accepts). */
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
    const snapshot = await messagesRes.json();
    // The snapshot is the whole transcript: the context publications the
    // run prepended (date, on-demand tools) are part of it, so the turn is
    // counted without them.
    const conversation = conversationOf(
      snapshot.messages as Array<{ role: string }>,
    );
    assertEquals(conversation.length, 2);
    assertEquals(conversation[1]!.role, "assistant");
    assertEquals(
      snapshot.messages.some((m: { role: string }) => m.role === "context"),
      true,
      "the context publications travel with the transcript",
    );
    // The snapshot carries the run state next to the transcript: the run
    // finished before it was taken.
    assertEquals(snapshot.running, false);
    // The rest of the live state travels with it: nothing is pending, the
    // session has not failed, and the title is current.
    assertEquals(snapshot.questions, []);
    assertEquals(snapshot.error, undefined);
    assertEquals(snapshot.name, "api-test");

    await removeDirRetry(root);
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
    const chatConversation = conversationOf(
      messages.messages as Array<{
        role: string;
        content: Array<{ text: string }>;
      }>,
    );
    assertEquals(chatConversation.length, 2);
    assertEquals(
      chatConversation[1]!.content[0]!.text,
      "chat reply",
    );

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
    // The transcript also carries the context publications the runs
    // prepended (date, on-demand tools): the turns are counted without
    // them.
    let conversation: Array<{ role: string; timestamp: number }> = [];
    for (let i = 0; i < 100 && conversation.length < 4; i++) {
      messages = (await (
        await json(base, `/api/sessions/${session.id}/messages`)
      ).json()).messages;
      conversation = conversationOf(messages);
      if (conversation.length < 4) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    assertEquals(conversation.length, 4);

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

    // Rewind the second turn: only the first turn remains. The rewind
    // targets the second user message (the publications at the head of the
    // transcript are not turns).
    const secondUser = conversation.filter((m) => m.role === "user")[1]!;
    const rewindRes = await json(base, `/api/sessions/${session.id}/rewind`, {
      method: "POST",
      body: JSON.stringify({ timestamp: secondUser.timestamp }),
    });
    assertEquals(rewindRes.status, 200);
    const { messages: truncated } = await (
      await json(base, `/api/sessions/${session.id}/messages`)
    ).json();
    const remaining = conversationOf(truncated);
    assertEquals(remaining.length, 2);
    assertEquals(remaining[0]!.role, "user");
    assertEquals(remaining[1]!.role, "assistant");

    // Unknown timestamps map to 404.
    const unknown = await json(base, `/api/sessions/${session.id}/rewind`, {
      method: "POST",
      body: JSON.stringify({ timestamp: 1 }),
    });
    assertEquals(unknown.status, 404);

    await removeDirRetry(root);
  } finally {
    server.shutdown();
    core.close();
  }
});

Deno.test("revision endpoint tracks the events of a session", async () => {
  // The web's probe reads this on a low interval and re-reads the snapshot
  // only when the count moved; it must therefore start at 0, grow with the
  // run, and agree with the snapshot's own `rev` (the client seeds its
  // marker from that).
  const { core, server, faux, base } = await setup();
  try {
    const root = await Deno.makeTempDir({ prefix: "lumisca-srv-" });
    const ws = await (await json(base, "/api/workspaces", {
      method: "POST",
      body: JSON.stringify({ name: "ws", folders: [root] }),
    })).json();
    const session = await (await json(base, "/api/sessions", {
      method: "POST",
      body: JSON.stringify({
        workspaceId: ws.id,
        modelProvider: faux.provider.id,
        modelId: faux.getModel().id,
      }),
    })).json();

    const revision = async (): Promise<number> =>
      (await (await json(base, `/api/sessions/${session.id}/revision`))
        .json()).rev;
    // The probe deliberately does not open the session: a count with no
    // events behind it is 0.
    assertEquals(await revision(), 0);

    faux.setResponses([fauxAssistantMessage("hi")]);
    await json(base, `/api/sessions/${session.id}/prompt`, {
      method: "POST",
      body: JSON.stringify({ text: "Hi" }),
    });
    await core.getAgent(session.id)!.waitForIdle();

    const afterRun = await revision();
    assert(afterRun > 0, "the run's events advanced the revision");
    const snapshot = await (await json(
      base,
      `/api/sessions/${session.id}/messages`,
    )).json();
    assertEquals(snapshot.rev > 0, true);
    // The count only grows, so the snapshot (read first) cannot be ahead of
    // the revision read after it.
    assertEquals(snapshot.rev <= afterRun, true);

    await removeDirRetry(root);
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
    await removeDirRetry(root);
  } finally {
    server.shutdown();
    core.close();
  }
});

Deno.test("federation: hub reports its peers and proxies their workspaces and sessions", async () => {
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

      // Peer reachability: the registered peer answers, the hub itself is
      // not listed (a hub is not its own peer), and the URL travels with the
      // entry so the UI can label a nameless one by its host.
      const peersRes = await json(hubBase, "/api/fed/peers", {
        headers: auth,
      });
      assertEquals(peersRes.status, 200);
      const { peers } = await peersRes.json() as {
        peers: Array<{
          id: string;
          name: string;
          url: string;
          ok: boolean;
          error?: string;
        }>;
      };
      assertEquals(peers.length, 1);
      assertEquals(peers[0]?.id, "peer1");
      assertEquals(peers[0]?.name, "自宅");
      assertEquals(peers[0]?.url, peerBase);
      assertEquals(peers[0]?.ok, true);

      // The hub's own workspaces stay its own: they are not merged with a
      // peer's, because a workspace belongs to the machine the window
      // displays (switching machines is the title bar's job).
      const hubWorkspaces = await json(hubBase, "/api/workspaces", {
        headers: auth,
      });
      const hubList = await hubWorkspaces.json() as Array<{ name: string }>;
      assertEquals(hubList.map((w) => w.name), ["hub-ws"]);
      const peerWorkspaces = await json(hubBase, "/api/fed/peer1/workspaces", {
        headers: auth,
      });
      const peerList = await peerWorkspaces.json() as Array<{
        id: string;
        name: string;
      }>;
      assertEquals(peerList.map((w) => w.name), ["peer-ws"]);
      const peerWorkspaceId = peerList[0]?.id;

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
      const { messages: msgs } = await messages.json();
      // The proxied transcript carries the context publications of the
      // peer's run too; the turn is counted without them.
      const fedConversation = conversationOf(
        msgs as Array<{ role: string; content: Array<{ text: string }> }>,
      );
      assertEquals(fedConversation.length, 2);
      assertEquals(fedConversation[1]!.role, "assistant");
      assertEquals(
        fedConversation[1]!.content[0]!.text,
        "Hi from peer!",
        "the peer's prompt roundtrip must produce the real answer",
      );

      // Unknown peer → 404.
      const unknown = await json(hubBase, "/api/fed/nope/workspaces", {
        headers: auth,
      });
      assertEquals(unknown.status, 404);
      hubWs.close();
      await removeDirRetry(hubRoot);
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
        "/api/fed/peer1/fs/places",
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
    const session = await core.createSession({
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
    // Await the MCP teardown: the spawned server runs with the workspace
    // folder as its working directory, which blocks deletion on Windows
    // until the child is dead.
    await core.close();
    // The MCP server process must be dead before the dir can go.
    await removeDirRetry(root);
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
          phases: [{
            name: "実装",
            tasks: [{ name: "調査する" }, { name: "実装する" }],
          }],
        }),
      ]),
      fauxAssistantMessage("planned"),
    ]);
    // Drive the run through the real HTTP path: the prompt endpoint is
    // fire-and-forget, so subscribe before sending and await agent_end.
    const finished = new Promise<void>((resolve) => {
      const unsubscribe = core.subscribe((event) => {
        if (event.type === "agent_end" && event.sessionId === session.id) {
          unsubscribe();
          resolve();
        }
      });
    });
    const prompted = await json(base, `/api/sessions/${session.id}/prompt`, {
      method: "POST",
      body: JSON.stringify({ text: "Plan the work" }),
    });
    assertEquals(prompted.status, 200);
    await finished;

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

Deno.test("stella API: the conversation is opened by agent and never listed as a session", async () => {
  const { core, faux, server, base } = await setup();
  try {
    await core.setProviderApiKey(faux.provider.id, "faux-key");
    // Attach a machine that reports itself available; the conversation only
    // needs the manager to exist (its tools are exercised elsewhere).
    core.setStellaVm({
      status: () =>
        Promise.resolve({ state: "stopped", vncPort: null, reason: "" }),
      start: () =>
        Promise.resolve({ state: "running", vncPort: 1, reason: "" }),
      stop: () => Promise.resolve(),
      vncPort: () => Promise.resolve(null),
    });
    // An agent must exist first: stella's conversation belongs to one.
    const created = await json(base, "/api/stella/agents", {
      method: "POST",
      body: JSON.stringify({ name: "Aide", role: "Help with the work." }),
    });
    assertEquals(created.status, 201);
    const agent = await created.json() as { id: string; name: string };

    // The conversation is addressed by agent: a client never learns (or
    // needs) the session id, so stella cannot drift into "a tab".
    const response = await json(
      base,
      `/api/stella/conversations/${agent.id}`,
    );
    assertEquals(response.status, 200);
    const snapshot = await response.json() as {
      entries: unknown[];
      running: boolean;
      questions: unknown[];
      handover: unknown;
      agentName: string;
      sessionId: string;
      rev: number;
    };
    assertEquals(snapshot.entries, []);
    assertEquals(snapshot.running, false);
    assertEquals(snapshot.questions, []);
    assertEquals(snapshot.handover, null);
    // The conversation is named after the agent, so its title is the
    // counterpart rather than a session label.
    assertEquals(snapshot.agentName, "Aide");
    assertEquals(typeof snapshot.sessionId, "string");

    // A second call finds the same conversation instead of making another.
    const again = await json(base, `/api/stella/conversations/${agent.id}`);
    assertEquals(again.status, 200);
    assertEquals(
      (await again.json() as { sessionId: string }).sessionId,
      snapshot.sessionId,
    );

    // The session list must never offer it.
    const list = await json(base, "/api/sessions");
    assertEquals(await list.json(), []);

    // The old session-addressed endpoint is gone: the client has no path
    // back to "one conversation = one session".
    const retired = await json(base, `/api/stella/session?agentId=${agent.id}`);
    assertEquals(retired.status, 404);
  } finally {
    server.shutdown();
    await core.close();
  }
});

Deno.test("panel snapshots answer for a session with nothing running", async () => {
  const { core, server, base, faux } = await setup();
  try {
    const created = await json(base, "/api/sessions", {
      method: "POST",
      body: JSON.stringify({
        modelProvider: faux.provider.id,
        modelId: faux.getModel().id,
      }),
    });
    assertEquals(created.status, 201);
    const session = await created.json() as { id: string };

    // The four resync endpoints the web re-reads after a socket drop. Each
    // one opens the session first, so an empty answer still proves the route
    // (and its ordering against static paths) is wired.
    const todo = await json(base, `/api/sessions/${session.id}/todo`);
    assertEquals(todo.status, 200);
    assertEquals(await todo.json(), { todos: [] });

    const tasks = await json(base, `/api/sessions/${session.id}/tasks`);
    assertEquals(tasks.status, 200);
    assertEquals(await tasks.json(), { tasks: [] });

    const background = await json(
      base,
      `/api/sessions/${session.id}/background`,
    );
    assertEquals(background.status, 200);
    assertEquals(await background.json(), { backgrounds: [] });

    const goal = await json(base, `/api/sessions/${session.id}/goal`);
    assertEquals(goal.status, 200);
    assertEquals(await goal.json(), { goal: null });

    // Cancelling a goal nobody started is a no-op, not an error: the panel's
    // button stays clickable until its own `goal_done` arrives.
    const cancelled = await json(base, `/api/sessions/${session.id}/goal`, {
      method: "DELETE",
    });
    assertEquals(cancelled.status, 200);
    assertEquals(await cancelled.json(), { ok: true });

    // A session that does not exist is a 404 on every one of them.
    const missing = await json(base, "/api/sessions/nope/todo");
    assertEquals(missing.status, 404);
  } finally {
    server.shutdown();
    await core.close();
  }
});

Deno.test("saved prompts and user providers: the routes exist and validate", async () => {
  const { core, server, base } = await setup();
  try {
    // Saved prompts: list, create, update, delete.
    const empty = await json(base, "/api/settings/saved-prompts");
    assertEquals(empty.status, 200);
    assertEquals(await empty.json(), { prompts: [] });

    const created = await json(base, "/api/settings/saved-prompts", {
      method: "POST",
      body: JSON.stringify({ id: "p1", label: "L", prompt: "do it" }),
    });
    assertEquals(created.status, 201);
    const updated = await json(base, "/api/settings/saved-prompts/p1", {
      method: "PUT",
      body: JSON.stringify({ label: "L2" }),
    });
    assertEquals(updated.status, 200);
    assertEquals((await updated.json() as { label: string }).label, "L2");
    const removed = await json(base, "/api/settings/saved-prompts/p1", {
      method: "DELETE",
    });
    assertEquals(removed.status, 200);

    // A malformed body is a 400, and the message names the missing field.
    const bad = await json(base, "/api/settings/saved-prompts", {
      method: "POST",
      body: JSON.stringify({ id: "p2" }),
    });
    assertEquals(bad.status, 400);

    // User-defined providers: the list is empty on a fresh core, and a
    // provider without a base URL is refused by the core (400, not 500).
    const providers = await json(base, "/api/providers/user");
    assertEquals(providers.status, 200);
    assertEquals(await providers.json(), []);
    const noBaseUrl = await json(base, "/api/providers/user", {
      method: "POST",
      body: JSON.stringify({ id: "u1", name: "U", baseUrl: "", apiKey: "k" }),
    });
    assertEquals(noBaseUrl.status, 400);
  } finally {
    server.shutdown();
    await core.close();
  }
});
