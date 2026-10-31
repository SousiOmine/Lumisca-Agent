import { basename, dirname, join, parse } from "node:path";
import { realpathSync } from "node:fs";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type StreamRequest,
} from "@lumisca/core";
import { assert, assertEquals } from "@std/assert";
import { LumiscaCore, type TodoPhase } from "@lumisca/core";
import {
  COMMAND_SAFETY_APPROVALS_KEY,
  LANGUAGE_KEY,
} from "@lumisca/core/shared";
import {
  type AppOptions,
  createApp,
  disposeServer,
  startServer,
} from "./app.ts";
import { validateHostConfig } from "./security.ts";
import { MINI_PNG, removeDirRetry } from "@lumisca/core/test-utils";
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
function conversationOf<T extends { role: string }>(messages: T[]): T[] {
  return messages.filter((m) => m.role !== "context");
}

/** The base64 body an icon upload takes: the same bytes the store's tests
 * use, in the shape a browser's `FileReader` produces (minus the data-URL
 * header, which the route also accepts). */
function pngBase64(): string {
  let binary = "";
  for (const byte of MINI_PNG) binary += String.fromCharCode(byte);
  return btoa(binary);
}

Deno.test("health and workspaces API", async () => {
  const { core, server, base } = await setup();
  try {
    const health = await fetch(`${base}/api/health`);
    assertEquals(health.status, 200);
    const healthBody = await health.json() as { ok: boolean; now: number };
    assertEquals(healthBody.ok, true);
    // The timestamp proves the event loop answered (liveness for hang
    // detection), not just the TCP listener.
    assertEquals(typeof healthBody.now, "number");

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

    await removeDirRetry(root);
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

    await removeDirRetry(root);
  } finally {
    server.shutdown();
    core.close();
  }
});

Deno.test("skills API lists the workspace catalog and the chat subset", async () => {
  const { core, server, base } = await setup();
  try {
    const root = await Deno.makeTempDir({ prefix: "lumisca-srv-" });
    const create = await json(base, "/api/workspaces", {
      method: "POST",
      body: JSON.stringify({ name: "ws", folders: [root] }),
    });
    const ws = await create.json();

    // A workspace skill fixture: the only source of skills in a test core
    // (global discovery is disabled, and no browser backend is attached, so
    // the built-in web-browser skill is gated out).
    const skillDir = join(root, ".agents", "skills", "demo");
    await Deno.mkdir(skillDir, { recursive: true });
    await Deno.writeTextFile(
      join(skillDir, "SKILL.md"),
      "---\nname: demo\ndescription: Demo skill.\n---\n\nDo the demo thing.\n",
    );

    const forWorkspace = await json(
      base,
      `/api/skills?workspaceId=${ws.id}`,
    );
    assertEquals(forWorkspace.status, 200);
    assertEquals((await forWorkspace.json()).skills, [
      { name: "demo", description: "Demo skill." },
    ]);

    // Without a workspaceId the endpoint answers for a chat session, which
    // sees no workspace skill (the same contract as POST /sessions).
    const chat = await json(base, "/api/skills");
    assertEquals(chat.status, 200);
    assertEquals((await chat.json()).skills, []);

    // An unknown workspace is a 404, never a fallback to the chat list.
    const unknown = await json(base, "/api/skills?workspaceId=nope");
    assertEquals(unknown.status, 404);

    await removeDirRetry(root);
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

    await removeDirRetry(root);
    await removeDirRetry(extra);
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

Deno.test("messages snapshot serves a window and the way back", async () => {
  // A long conversation is not sent whole on every (re)connect: the snapshot
  // is the newest window, and `older` is the cursor for the window before it
  // (see core's session/transcript-window.ts). The turn rule keeps a window
  // from starting in the middle of one.
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

    // Three exchanges: six messages, plus the context publications of the
    // first run.
    const usage = { input: 100, output: 10, cacheRead: 900, cacheWrite: 0 };
    faux.setResponses([
      fauxAssistantMessage("one", { usage }),
      fauxAssistantMessage("two", { usage }),
      fauxAssistantMessage("three", { usage }),
    ]);
    for (const text of ["first", "second", "third"]) {
      await json(base, `/api/sessions/${session.id}/prompt`, {
        method: "POST",
        body: JSON.stringify({ text }),
      });
      await core.getAgent(session.id)!.waitForIdle();
    }

    type Snapshot = {
      messages: Array<{ role: string }>;
      older: string | null;
      usage: { turns: number };
    };

    // One turn at a time: the newest window holds the last prompt and its
    // answer, and starts at the prompt.
    const newest = await (await json(
      base,
      `/api/sessions/${session.id}/messages?limit=2`,
    )).json() as Snapshot;
    assertEquals(conversationOf(newest.messages).length, 2);
    assertEquals(conversationOf(newest.messages)[0]!.role, "user");
    assert(newest.older !== null, "history exists before the window");

    // The meter counts the WHOLE transcript, not the window: the client
    // cannot count turns it did not load.
    assertEquals(newest.usage.turns, 3);

    // The cursor walks back one window at a time and ends at the beginning.
    let older: string | null = newest.older;
    let seen = newest.messages.length;
    for (let guard = 0; older !== null && guard < 10; guard++) {
      const page = await (await json(
        base,
        `/api/sessions/${session.id}/messages?limit=2&older=${
          encodeURIComponent(older)
        }`,
      )).json() as Snapshot;
      seen += page.messages.length;
      older = page.older;
    }
    assertEquals(older, null, "the walk ends at the transcript's beginning");
    assertEquals(seen, core.getAgent(session.id)!.messages.length);

    // A cursor the transcript no longer has is a conflict, not a guess.
    const stale = await json(
      base,
      `/api/sessions/${session.id}/messages?older=${
        encodeURIComponent('["user",1,""]')
      }`,
    );
    assertEquals(stale.status, 409);

    // A page size the core cannot honour is the caller's mistake.
    const bad = await json(
      base,
      `/api/sessions/${session.id}/messages?limit=0`,
    );
    assertEquals(bad.status, 400);

    await removeDirRetry(root);
  } finally {
    server.shutdown();
    core.close();
  }
});

Deno.test("messages snapshot reports a run that is still going", async () => {
  // The reported bug: a client that asks for the transcript while the agent
  // is working — a page load, a WS drop, a tab opened on the session — must
  // also be told that the run is active. The event stream carries no
  // snapshot (`agent_start` is not replayed for a run that is already
  // going), so the transcript alone would show the live run as finished:
  // work log collapsed under 作業完了. Both halves must come back from the
  // one snapshot, read at the same instant.
  const { core, server, faux, base } = await setup();
  try {
    const root = await Deno.makeTempDir({ prefix: "lumisca-srv-" });
    const create = await json(base, "/api/workspaces", {
      method: "POST",
      body: JSON.stringify({ name: "ws", folders: [root] }),
    });
    const ws = await create.json();

    // Hold the run inside its first LLM call until the assertions below
    // are done: the snapshot must report it as running.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    faux.setResponses([
      async () => {
        await gate;
        return fauxAssistantMessage("done");
      },
    ]);
    const session = await (await json(base, "/api/sessions", {
      method: "POST",
      body: JSON.stringify({
        workspaceId: ws.id,
        modelProvider: faux.provider.id,
        modelId: faux.getModel().id,
      }),
    })).json();

    // Fire-and-forget: the run announces itself through the events.
    await json(base, `/api/sessions/${session.id}/prompt`, {
      method: "POST",
      body: JSON.stringify({ text: "Hi" }),
    });
    let snapshot: { messages: unknown[]; running: boolean } = {
      messages: [],
      running: false,
    };
    for (let i = 0; i < 100; i++) {
      snapshot = await (
        await json(base, `/api/sessions/${session.id}/messages`)
      ).json();
      if (snapshot.running) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assertEquals(snapshot.running, true, "the live run is reported");
    // The live transcript carries the user message the run is answering,
    // with the context publications that precede it (counted separately).
    const live = conversationOf(
      snapshot.messages as Array<{ role: string }>,
    );
    assertEquals(
      live.length,
      1,
      "the snapshot carries the transcript too",
    );
    assertEquals(live[0]!.role, "user");

    release();
    await core.getAgent(session.id)!.waitForIdle();
    snapshot = await (
      await json(base, `/api/sessions/${session.id}/messages`)
    ).json();
    assertEquals(snapshot.running, false, "the finished run is not");
    assertEquals(
      conversationOf(snapshot.messages as Array<{ role: string }>).length,
      2,
    );

    await removeDirRetry(root);
  } finally {
    server.shutdown();
    core.close();
  }
});

Deno.test("messages snapshot carries a pending ask for a reconnecting client", async () => {
  // The ask tool blocks the run until the user answers, and `question`
  // events are never replayed: a client that (re)connects while the run is
  // blocked learns about the questions from this snapshot — without them
  // the run would wait forever with no visible way to answer.
  const { core, server, faux, base } = await setup();
  try {
    const root = await Deno.makeTempDir({ prefix: "lumisca-srv-" });
    const ws = await (await json(base, "/api/workspaces", {
      method: "POST",
      body: JSON.stringify({ name: "ws", folders: [root] }),
    })).json();

    const questions = [{
      id: "q1",
      question: "Which language?",
      options: [{ label: "Deno" }, { label: "Node" }],
    }];
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("ask", { questions })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("thanks"),
    ]);
    const session = await (await json(base, "/api/sessions", {
      method: "POST",
      body: JSON.stringify({
        workspaceId: ws.id,
        modelProvider: faux.provider.id,
        modelId: faux.getModel().id,
      }),
    })).json();

    await json(base, `/api/sessions/${session.id}/prompt`, {
      method: "POST",
      body: JSON.stringify({ text: "Hi" }),
    });

    // Wait for the run to reach the ask and block there.
    let snapshot: {
      running: boolean;
      questions: Array<{ toolCallId: string; questions: unknown[] }>;
    } = { running: false, questions: [] };
    for (let i = 0; i < 100; i++) {
      snapshot = await (await json(
        base,
        `/api/sessions/${session.id}/messages`,
      )).json();
      if (snapshot.questions.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assertEquals(snapshot.running, true, "the blocked run is reported");
    assertEquals(snapshot.questions.length, 1);
    assertEquals(snapshot.questions[0]!.questions, questions);

    // Answering through the API (what the reconnected client does) lets the
    // blocked run continue; the ask then leaves the snapshot.
    await json(base, `/api/sessions/${session.id}/answer`, {
      method: "POST",
      body: JSON.stringify({
        toolCallId: snapshot.questions[0]!.toolCallId,
        answers: [{ id: "q1", values: ["Deno"] }],
      }),
    });
    await core.getAgent(session.id)!.waitForIdle();
    snapshot = await (await json(
      base,
      `/api/sessions/${session.id}/messages`,
    )).json();
    assertEquals(snapshot.questions, []);
    assertEquals(snapshot.running, false);

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

Deno.test("websocket streams agent events", async () => {
  const { core, server, faux, base } = await setup();
  try {
    const root = await Deno.makeTempDir({ prefix: "lumisca-srv-" });
    await Deno.writeTextFile(join(root, "a.txt"), "one\n");
    const create = await json(base, "/api/workspaces", {
      method: "POST",
      body: JSON.stringify({ name: "ws", folders: [root] }),
    });
    const ws = await create.json();

    // One tool turn, then the answer: a tool result must reach the client as
    // a message of its own. The UI builds the tool line's checkmark and its
    // `+N -M` badge from that message (a transcript message), so a client
    // that is told about `tool_end` alone leaves the line unmarked until it
    // happens to re-read the transcript snapshot.
    faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall("edit", {
          path: `${basename(root)}/a.txt`,
          old_string: "one",
          new_string: "one\ntwo",
        })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("Streamed!"),
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

    const socket = new WebSocket(`ws://127.0.0.1:${server.addr.port}/ws`);
    const events: Array<Record<string, unknown>> = [];
    const done = new Promise<void>((resolve) => {
      socket.onmessage = (e) => {
        const event = JSON.parse(String(e.data));
        events.push(event);
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
    const types = events.map((e) => e.type);
    assertEquals(types.includes("agent_start"), true);
    assertEquals(types.includes("message_end"), true);
    assertEquals(types.includes("agent_end"), true);

    const resultEnd = events.find((e) =>
      e.type === "message_end" &&
      (e.message as { role?: string }).role === "toolResult"
    );
    assert(
      resultEnd !== undefined,
      "no tool result message reached the client",
    );
    const result = resultEnd.message as {
      toolName?: string;
      details?: { addedLines?: number; removedLines?: number };
    };
    assertEquals(result.toolName, "edit");
    assertEquals(result.details?.addedLines, 1);
    assertEquals(result.details?.removedLines, 0);

    // Every frame for the session carries the emitting server's revision,
    // one step per event: a client compares it against what it has seen and
    // re-reads the snapshot when it jumps (see LumiscaCore's revision).
    const revs = events
      .filter((e) => e.sessionId === session.id && typeof e.rev === "number")
      .map((e) => e.rev as number);
    assertEquals(revs.length > 0, true);
    assertEquals(
      revs.every((rev, i) => rev === i + 1),
      true,
      `revisions must advance by one: ${revs.join(", ")}`,
    );

    await removeDirRetry(root);
  } finally {
    server.shutdown();
    core.close();
  }
});

Deno.test("the event stream carries heartbeat frames while it is idle", async () => {
  // An idle stream looks exactly like a dead socket (nothing arrives either
  // way), so the server proves it is still there on a fixed cadence; the
  // client's watchdog treats silence past its deadline as a dead socket
  // (see core/shared/heartbeat.ts). The cadence is shortened here so the
  // test does not wait 15 seconds.
  const { core, server } = await setup(undefined, { heartbeatMs: 20 });
  try {
    const socket = new WebSocket(`ws://127.0.0.1:${server.addr.port}/ws`);
    const frames: Array<Record<string, unknown>> = [];
    await new Promise<void>((resolve) => {
      socket.onmessage = (e) => {
        const frame = JSON.parse(String(e.data)) as Record<string, unknown>;
        frames.push(frame);
        // Two frames prove the cadence repeats, not just that one was sent.
        if (frames.filter((f) => f.type === "heartbeat").length === 2) {
          resolve();
        }
      };
    });
    socket.close();
    // Nothing else happens on an idle stream, and the heartbeat frame is
    // transport-level: it carries no peer id and no session id.
    assertEquals(frames.every((f) => f.type === "heartbeat"), true);
    assertEquals(frames[0], { type: "heartbeat" });
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
    const fallback = await (await fetch(`${base}/api/sessions/default-model`))
      .json();
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

Deno.test("filesystem browse API", async () => {
  const { core, server, base } = await setup();
  try {
    // The picker's sidebar places: the user folders that exist on this
    // machine, then its filesystem roots.
    const placesRes = await fetch(`${base}/api/fs/places`);
    assertEquals(placesRes.status, 200);
    const places = await placesRes.json() as Array<
      { kind: string; path: string }
    >;
    assertEquals(places.length > 0, true, "at least one place");
    for (const place of places) {
      assertEquals(
        ["home", "desktop", "documents", "downloads", "root"].includes(
          place.kind,
        ),
        true,
        `unknown place kind: ${place.kind}`,
      );
      // Only directories that exist are offered.
      assertEquals((await Deno.stat(place.path)).isDirectory, true);
    }
    assertEquals(places.some((place) => place.kind === "root"), true);
    // The home folder of the server's environment is one of them.
    const home = Deno.env.get("USERPROFILE") ?? Deno.env.get("HOME") ?? "";
    if (home !== "") {
      assertEquals(places.find((place) => place.kind === "home")?.path, home);
    }

    // Create a nested dir structure in a temp folder and browse it.
    const root = await Deno.makeTempDir({ prefix: "lumisca-fs-" });
    const sub = join(root, "alpha");
    await Deno.mkdir(sub, { recursive: true });
    await Deno.mkdir(join(sub, "beta"), { recursive: true });
    await Deno.writeTextFile(join(root, "file.txt"), "x");
    // A symlinked folder stays a folder (its dirent describes the link, but
    // the picker must still be able to pick the folder). Symlinks need
    // privileges on Windows.
    const linked = Deno.build.os !== "windows";
    if (linked) await Deno.symlink(sub, join(root, "link"), { type: "dir" });

    const browseRes = await fetch(
      `${base}/api/fs/browse?path=${encodeURIComponent(root)}`,
    );
    assertEquals(browseRes.status, 200);
    const browse = await browseRes.json() as {
      path: string;
      parent: string | null;
      breadcrumbs: Array<{ name: string; path: string }>;
      entries: Array<{ name: string; path: string; kind: string }>;
    };
    assertEquals(browse.path, root);
    // Folders first (the symlink included), then files.
    const expected: Array<{ name: string; path: string; kind: string }> = [
      { name: "alpha", path: sub, kind: "dir" },
    ];
    if (linked) {
      expected.push({ name: "link", path: join(root, "link"), kind: "dir" });
    }
    expected.push({
      name: "file.txt",
      path: join(root, "file.txt"),
      kind: "file",
    });
    assertEquals(browse.entries, expected);
    // The address bar walks from the filesystem root down to this folder.
    assertEquals(browse.breadcrumbs.at(-1), {
      name: basename(root),
      path: root,
    });
    assertEquals(browse.breadcrumbs[0]?.path, parse(root).root);
    assertEquals(browse.parent, dirname(root));

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

    await removeDirRetry(root);
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
  // The ambient environment is the test's own object, not the process's (the
  // test runner shares one process environment across every file).
  const ambient: Record<string, string> = { ANTHROPIC_API_KEY: "sk-env-only" };
  const { core, server, base } = await setup(() => ambient);
  try {
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

Deno.test("settings API refuses a preference it does not declare", async () => {
  const { core, server, base } = await setup();
  try {
    // A typo, or a client that invents a key: the settings file is shared by
    // many owners (preferences, model records, credentials), so an unknown
    // key must not become a permanent dead entry.
    const res = await json(base, "/api/settings/some_invented_key", {
      method: "PUT",
      body: JSON.stringify({ value: "x" }),
    });
    assertEquals(res.status, 400);
    const stored = core.getSetting("some_invented_key");
    assertEquals(stored, undefined);
  } finally {
    server.shutdown();
    core.close();
  }
});

Deno.test("computer use toggle goes through the capability path", async () => {
  const { core, server, base } = await setup();
  try {
    // This core has no computer host attached (only the server's launcher
    // attaches one), so enabling must be refused with the machine's reason
    // and store nothing. A plain settings write would have answered 200 —
    // the 503 is what proves the toggle reaches setComputerUseEnabled.
    const enable = await json(base, "/api/settings/computer_use_enabled", {
      method: "PUT",
      body: JSON.stringify({ value: "1" }),
    });
    assertEquals(enable.status, 503);
    assertEquals((await enable.json()).error.length > 0, true);
    const settings = await (await fetch(`${base}/api/settings`))
      .json() as Record<string, string>;
    assertEquals(settings["computer_use_enabled"], undefined);

    // Disabling is always accepted: it is the safe direction, and a session
    // that was seeded while the feature was on must be able to lose it.
    const disable = await json(base, "/api/settings/computer_use_enabled", {
      method: "PUT",
      body: JSON.stringify({ value: "" }),
    });
    assertEquals(disable.status, 200);
    assertEquals(core.isComputerUseEnabled(), false);
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

    // The conversation's own stream is under /api, so the same guard covers
    // it (a token-less handshake never reaches the upgrade).
    const stellaDenied = await app.fetch(
      new Request("http://127.0.0.1:8000/api/stella/conversations/a/events", {
        headers: HOST,
      }),
    );
    assertEquals(stellaDenied.status, 401);
    const stellaOk = await app.fetch(
      new Request(
        "http://127.0.0.1:8000/api/stella/conversations/a/events?token=secret-token",
        { headers: HOST },
      ),
    );
    assertEquals(stellaOk.status !== 401 && stellaOk.status !== 403, true);

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

Deno.test("token auth remembers a presented token in a cookie", async () => {
  const faux = fauxProvider();
  const core = LumiscaCore.forTesting([faux.provider]);
  const app = createApp(core, { token: "secret-token" });
  const HOST = { host: "127.0.0.1:8000" };
  try {
    // The first visit carries the token in the URL (that is what the
    // desktop shell and `service install` hand out). The answer stores it in
    // a cookie — the point of this test — and keeps passing the token down
    // to the page, which the desktop shell's bridge key depends on.
    const first = await app.fetch(
      new Request("http://127.0.0.1:8000/?token=secret-token", {
        headers: HOST,
      }),
    );
    assertEquals(first.status, 200);
    const setCookie = first.headers.get("set-cookie") ?? "";
    assertEquals(
      setCookie.startsWith("lumisca_token_8000=secret-token"),
      true,
      setCookie,
    );
    assertEquals(setCookie.includes("HttpOnly"), true);
    assertEquals(setCookie.includes("SameSite=Lax"), true);
    assertEquals(
      (await first.text()).includes(
        'src="/assets/initial-data.js?token=secret-token"',
      ),
      true,
    );

    // From then on the browser sends only the cookie: the address bar has no
    // token, yet the app comes up — the guard, the API and the WebSocket all
    // accept the remembered credential.
    const remembered = { ...HOST, cookie: "lumisca_token_8000=secret-token" };
    const page = await app.fetch(
      new Request("http://127.0.0.1:8000/", { headers: remembered }),
    );
    assertEquals(page.status, 200);
    // Nothing to tell the browser again — the cookie is already there.
    assertEquals(page.headers.get("set-cookie"), null);
    // The page keeps carrying the token: the desktop shell's bridge key and
    // the UI's request header are built from it, and a reload without
    // `?token=` (the client strips it after the first load) must not lose
    // them.
    assertEquals(
      (await page.text()).includes(
        'src="/assets/initial-data.js?token=secret-token"',
      ),
      true,
    );

    const data = await app.fetch(
      new Request("http://127.0.0.1:8000/assets/initial-data.js", {
        headers: remembered,
      }),
    );
    assertEquals(data.status, 200);
    assertEquals(
      (await data.text()).includes('window.__LUMISCA_TOKEN__ = "secret-token"'),
      true,
    );

    // API and WebSocket (the UI sends no header on either) pass on the
    // cookie alone. The upgrade itself does not complete without websocket
    // headers, so assert only that it is not the guard's refusal.
    const api = await app.fetch(
      new Request("http://127.0.0.1:8000/api/health", { headers: remembered }),
    );
    assertEquals(api.status, 200);
    const ws = await app.fetch(
      new Request("http://127.0.0.1:8000/ws", { headers: remembered }),
    );
    assertEquals(ws.status !== 401 && ws.status !== 403, true);

    // A cookie that does not match (another server instance, a rotated
    // token) is worth nothing; a browser gets an explanation instead of the
    // JSON blob an API client would see.
    // This page is rendered before the app bundle loads, so its text comes
    // straight from the catalogue. Pin the language first: the page loads
    // above already resolved it for real, and every later request follows
    // the stored value (a 401 never writes one).
    core.setSetting(LANGUAGE_KEY, "ja");
    const stale = await app.fetch(
      new Request("http://127.0.0.1:8000/", {
        headers: {
          ...remembered,
          cookie: "lumisca_token_8000=old-token",
          accept: "text/html",
        },
      }),
    );
    assertEquals(stale.status, 401);
    assertEquals((await stale.text()).includes("トークンが必要です"), true);

    const denied = await app.fetch(
      new Request("http://127.0.0.1:8000/api/health", { headers: HOST }),
    );
    assertEquals(denied.status, 401);
    assertEquals(
      (await denied.json()).error,
      "Unauthorized: missing or invalid token",
    );

    // Two servers on one host stay apart: the cookie of the other port is
    // not this server's credential (see auth-cookie.ts).
    const otherPort = await app.fetch(
      new Request("http://127.0.0.1:8000/", {
        headers: {
          host: "127.0.0.1:8000",
          cookie: "lumisca_token_8100=secret-token",
        },
      }),
    );
    assertEquals(otherPort.status, 401);

    // Presenting the token again refreshes a stale cookie.
    const refreshed = await app.fetch(
      new Request("http://127.0.0.1:8000/?token=secret-token", {
        headers: { ...remembered, cookie: "lumisca_token_8000=old-token" },
      }),
    );
    assertEquals(refreshed.status, 200);
    assertEquals(
      (refreshed.headers.get("set-cookie") ?? "").startsWith(
        "lumisca_token_8000=secret-token",
      ),
      true,
    );
  } finally {
    core.close();
  }
});

Deno.test("the MCP OAuth callback is reachable without the token", async () => {
  const faux = fauxProvider();
  const core = LumiscaCore.forTesting([faux.provider]);
  const app = createApp(core, { token: "secret-token" });
  const HOST = { host: "127.0.0.1:8000" };
  try {
    // The browser that comes back from the authorization server may not be
    // the one the app is open in, so it carries no token cookie. The state
    // in the URL is the only credential the callback needs; an unknown one
    // is answered with the sign-in page, not with the guard's 401.
    const callback = await app.fetch(
      new Request(
        "http://127.0.0.1:8000/api/mcp/oauth/callback?state=unknown&code=x",
        { headers: { ...HOST, accept: "text/html" } },
      ),
    );
    assertEquals(callback.status, 404);
    const page = await callback.text();
    assert(page.includes("MCP の認証") || page.includes("MCP sign-in"));

    // Every other MCP path stays behind the token.
    const guarded = await app.fetch(
      new Request("http://127.0.0.1:8000/api/mcp/auth/s1", { headers: HOST }),
    );
    assertEquals(guarded.status, 401);
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
    // The language is resolved per request; the header pins it so the test
    // does not depend on the machine's locale.
    const index = await fetch(`${base}/`, {
      headers: { "accept-language": "ja-JP,ja;q=0.9" },
    });
    assertEquals(index.status, 200);
    const html = await index.text();
    // Static shell: an empty #root (the app renders client-side), the
    // externalized initial data (inline scripts are banned by the page
    // CSP), and the client bundle script.
    assertEquals(html.includes('<div id="root"></div>'), true);
    assertEquals(html.includes('src="/assets/initial-data.js"'), true);
    assertEquals(html.includes('src="/assets/app.js"'), true);
    assertEquals(html.includes("styles.css") || html.includes("<style>"), true);
    // The document already declares the app language (font fallback,
    // hyphenation, screen readers) before the client bundle runs.
    assertEquals(html.includes('<html lang="ja"'), true);
    // The desktop shell bridge (title bar: window controls and the
    // connection picker) is allowed by the CSP; in plain browsers nothing
    // listens there and the bridge is unused.
    assertEquals(html.includes("http://127.0.0.1:*"), true);

    // The initial-data script carries the serialized state, the language
    // included — the client seeds its catalogue with it before the first
    // render, so the UI never flashes the wrong language.
    const dataScript = await fetch(`${base}/assets/initial-data.js`);
    assertEquals(dataScript.status, 200);
    const dataText = await dataScript.text();
    assertEquals(dataText.includes("window.__INITIAL_DATA__"), true);
    assertEquals(dataText.includes('"language":"ja"'), true);

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

Deno.test("token-required page renders in the request's language", async () => {
  const faux = fauxProvider();
  const core = LumiscaCore.forTesting([faux.provider]);
  const app = createApp(core, { token: "secret-token" });
  const host = { host: "127.0.0.1:8000" };
  try {
    // Nothing is stored yet and no app page has been loaded, so the
    // browser's own preference decides — the only hint a page served
    // before the app exists can have.
    const ja = await app.fetch(
      new Request("http://127.0.0.1:8000/", {
        headers: { ...host, accept: "text/html", "accept-language": "ja-JP" },
      }),
    );
    assertEquals(ja.status, 401);
    assertEquals((await ja.text()).includes("トークンが必要です"), true);

    const en = await app.fetch(
      new Request("http://127.0.0.1:8000/", {
        headers: {
          ...host,
          accept: "text/html",
          "accept-language": "en-US,en;q=0.9",
        },
      }),
    );
    assertEquals(en.status, 401);
    assertEquals((await en.text()).includes("A token is required"), true);

    // A 401 is not a page load of the app: it resolved a language for its
    // own response but stored nothing, so the first real page load still
    // decides (and no later request inherits a guess from a rejected one).
    assertEquals(core.getSetting(LANGUAGE_KEY), undefined);
  } finally {
    core.close();
  }
});

Deno.test("server resolves the app language once and stores it", async () => {
  const faux = fauxProvider();
  const core = LumiscaCore.forTesting([faux.provider]);
  const server = startServer(core, 0, { repoRoot: Deno.cwd() });
  try {
    const base = `http://127.0.0.1:${server.addr.port}`;

    // First load: nothing is stored yet, so the browser's preference
    // decides — and the resolved value is remembered, because the language
    // must not depend on which client happens to create the next session.
    const first = await fetch(`${base}/`, {
      headers: { "accept-language": "en-US,en;q=0.9" },
    });
    assertEquals((await first.text()).includes('<html lang="en"'), true);
    const settings = await (await fetch(`${base}/api/settings`)).json();
    assertEquals(settings.language, "en");

    // A later request with a different preference does not flip it: the
    // stored setting is the source of truth, and the settings dialog is
    // its only writer after this point.
    const second = await fetch(`${base}/`, {
      headers: { "accept-language": "ja" },
    });
    assertEquals((await second.text()).includes('<html lang="en"'), true);

    // The user's explicit choice wins over every fallback.
    await fetch(`${base}/api/settings/language`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "ja" }),
    });
    const third = await fetch(`${base}/`);
    assertEquals((await third.text()).includes('<html lang="ja"'), true);
    const data = await fetch(`${base}/assets/initial-data.js`);
    assertEquals((await data.text()).includes('"language":"ja"'), true);

    // An unknown stored value is "not chosen": it is replaced by the
    // resolved language instead of reaching the page.
    await fetch(`${base}/api/settings/language`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "fr" }),
    });
    const fourth = await fetch(`${base}/`, {
      headers: { "accept-language": "ja" },
    });
    assertEquals((await fourth.text()).includes('<html lang="ja"'), true);
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
    // The entry point is what proves the bundle is the app rather than an
    // empty or stale file; a byte count only ever approximated that (it
    // breaks whenever the UI happens to shrink and passes for a bundle that
    // compiled the wrong entry).
    assertEquals(js.includes("input-composer"), true);
    assert(
      js.length > 10_000,
      `the bundle is ${js.length} bytes: too small to hold the client app`,
    );
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

    await removeDirRetry(root);
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
    const session = await core.createSession({
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
    // Await the MCP teardown (see the note above): the workspace folder
    // is the spawned server's working directory.
    await core.close();
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

Deno.test("compact condenses the history via the API", async () => {
  const { core, server, faux, base } = await setup();
  try {
    const root = await Deno.makeTempDir({ prefix: "lumisca-srv-" });
    const create = await json(base, "/api/workspaces", {
      method: "POST",
      body: JSON.stringify({ name: "ws", folders: [root] }),
    });
    const ws = await create.json();

    // The compaction tuning is a plain setting read by the agent on every
    // check: compact 4K below the window and keep only the newest 1K, so
    // both the automatic and the manual path find a span in this session.
    await json(base, "/api/settings/compaction_reserve_tokens", {
      method: "PUT",
      body: JSON.stringify({ value: "4000" }),
    });
    await json(base, "/api/settings/compaction_keep_recent_tokens", {
      method: "PUT",
      body: JSON.stringify({ value: "1000" }),
    });

    // A small window so a couple of big turns cross the pressure threshold
    // (the compaction only runs when a replacement can actually reduce the
    // request).
    const provider = faux.provider as unknown as {
      getModels(): Array<Record<string, unknown>>;
    };
    const original = provider.getModels;
    provider.getModels = () => [
      ...original.call(faux.provider),
      {
        id: "small-window",
        name: "small",
        api: "openai-completions",
        provider: faux.provider.id,
        contextWindow: 30_000,
        maxTokens: 3000,
      },
    ];

    const sessionRes = await json(base, "/api/sessions", {
      method: "POST",
      body: JSON.stringify({
        workspaceId: ws.id,
        modelProvider: faux.provider.id,
        modelId: "small-window",
      }),
    });
    const session = await sessionRes.json();

    // A context-inspecting responder: the summarization request is
    // recognized by the serialized conversation the compactor builds, so
    // the answer order does not depend on how the prompts are scheduled
    // (the prompt endpoint is fire-and-forget). The last summarization
    // prompt is kept so a test can check what the user's `/compact <focus>`
    // added to it.
    let summaryPrompt = "";
    faux.setResponses(
      Array.from({ length: 20 }, () => (context: StreamRequest) => {
        const last = context.messages.at(-1) as
          | { content?: Array<{ text?: string }> }
          | undefined;
        const text = last?.content?.[0]?.text ?? "";
        if (text.includes("<conversation>")) {
          summaryPrompt = text;
          return fauxAssistantMessage("## Summary\n- condensed");
        }
        return fauxAssistantMessage("ok");
      }),
    );
    for (let i = 0; i < 6; i++) {
      await json(base, `/api/sessions/${session.id}/prompt`, {
        method: "POST",
        body: JSON.stringify({ text: `turn ${i} ${"x".repeat(40_000)}` }),
      });
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    let messages: Array<{ role: string }> = [];
    for (let i = 0; i < 100; i++) {
      messages = (await (
        await json(base, `/api/sessions/${session.id}/messages`)
      ).json()).messages;
      if (messages.some((m) => m.role === "checkpoint")) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assertEquals(messages.some((m) => m.role === "checkpoint"), true);

    // The endpoint reports how many messages the manual call summarized (or
    // omits the count when nothing safe was left), and the typed focus is
    // carried into the summarization prompt.
    const compactRes = await json(
      base,
      `/api/sessions/${session.id}/compact`,
      {
        method: "POST",
        body: JSON.stringify({ instructions: "keep the file paths" }),
      },
    );
    assertEquals(compactRes.status, 200);
    const body = await compactRes.json();
    assertEquals(body.ok, true);
    assertEquals(typeof body.compacted, "number");
    assertEquals(
      summaryPrompt.includes("Additional focus: keep the file paths"),
      true,
    );

    // Nothing is deleted: the checkpoint is inserted, and the messages it
    // summarizes stay in the transcript.
    const { messages: after } = await (
      await json(base, `/api/sessions/${session.id}/messages`)
    ).json();
    const checkpointIndex = after.findIndex(
      (m: { role: string }) => m.role === "checkpoint",
    );
    assertEquals(checkpointIndex > 0, true);
    assertEquals(after[0].role !== "checkpoint", true);

    // An unknown session is a 404, like the other session routes.
    const missing = await json(base, "/api/sessions/nope/compact", {
      method: "POST",
    });
    assertEquals(missing.status, 404);

    // The optional focus is validated, not silently dropped.
    const badType = await json(base, `/api/sessions/${session.id}/compact`, {
      method: "POST",
      body: JSON.stringify({ instructions: 42 }),
    });
    assertEquals(badType.status, 400);
    const tooLong = await json(base, `/api/sessions/${session.id}/compact`, {
      method: "POST",
      body: JSON.stringify({ instructions: "x".repeat(2_001) }),
    });
    assertEquals(tooLong.status, 400);

    await removeDirRetry(root);
  } finally {
    server.shutdown();
    core.close();
  }
});

// --- stella mode ------------------------------------------------------------

Deno.test("stella API: the status reports the availability and the machine", async () => {
  const { core, server, base } = await setup();
  try {
    // No machine attached (the test core has none): stella is not offered,
    // and the reason is a sentence the selection screen shows.
    const status = await json(base, "/api/stella/status");
    assertEquals(status.status, 200);
    const body = await status.json() as {
      availability: { available: boolean; reason?: string };
      state: string;
    };
    assertEquals(body.availability.available, false);
    assertEquals(body.state, "unavailable");
    assert(
      body.availability.available === false &&
        body.availability.reason?.includes("not set up"),
      JSON.stringify(body),
    );
    // The chosen mode belongs to the CLIENT, so the server never reports
    // one: two clients showing the same server pick their own.
    assertEquals("mode" in body, false, JSON.stringify(body));
  } finally {
    server.shutdown();
    void core.close();
  }
});

Deno.test("stella API: the first agent list creates the starter agent", async () => {
  const { core, server, base } = await setup();
  try {
    const first = await json(base, "/api/stella/agents");
    const body = await first.json() as {
      agents: Array<{ id: string; name: string; role: string }>;
      defaultAgentId: string | null;
    };
    // A fresh installation has someone to talk to: an empty sidebar in front
    // of a disabled composer would be a wall in front of the whole mode.
    assertEquals(body.agents.length, 1);
    assertEquals(body.defaultAgentId, body.agents[0]!.id);
    assert(body.agents[0]!.name.length > 0, JSON.stringify(body));
    assert(body.agents[0]!.role.length > 0, JSON.stringify(body));

    // Reading again does not create a second one.
    const again = await json(base, "/api/stella/agents");
    assertEquals(
      ((await again.json()) as { agents: unknown[] }).agents.length,
      1,
    );

    // Deleting it is allowed, and the next read brings the mode back into a
    // usable state.
    await core.deleteStellaAgent(body.agents[0]!.id);
    const restored = await json(base, "/api/stella/agents");
    const after = await restored.json() as {
      agents: Array<{ id: string }>;
      defaultAgentId: string | null;
    };
    assertEquals(after.agents.length, 1);
    assertEquals(after.defaultAgentId, after.agents[0]!.id);
  } finally {
    server.shutdown();
    void core.close();
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

Deno.test("stella API: the conversation carries the words, never the model's context", async () => {
  // The reported symptom: `Date: …` and `On-demand tools` rows in stella's
  // chat. They are `context` publications — the model's history — and the
  // conversation endpoint must not serve them, while the session endpoint
  // (code mode) keeps serving them for its own transcript.
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
    const agent = await agentRes.json() as { id: string; name: string };

    const opened = await json(base, `/api/stella/conversations/${agent.id}`);
    const openedBody = await opened.json() as { sessionId: string };
    const sessionId = openedBody.sessionId;

    // The reply the model gives; the run also publishes the session's
    // context (date, on-demand tools) ahead of it.
    faux.setResponses([fauxAssistantMessage("一覧を出しました。")]);
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
      const body = await res.json() as { running: boolean };
      if (!body.running) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const snapshotRes = await json(
      base,
      `/api/stella/conversations/${agent.id}/messages`,
    );
    const snapshot = await snapshotRes.json() as {
      entries: Array<{ role: string; text: string; cards: string[] }>;
      running: boolean;
    };
    // The user's prompt and the agent's words, in order, and nothing else.
    assertEquals(snapshot.entries[0]?.role, "user");
    assertEquals(snapshot.entries[0]?.text, "bash で一覧を出して");
    assertEquals(
      snapshot.entries.some((entry) => entry.role === "assistant"),
      true,
    );
    for (const entry of snapshot.entries) {
      assertEquals(entry.role === "user" || entry.role === "assistant", true);
      // The model's context publications (date, on-demand tools) are not
      // entries; nor are tool results or notifications.
      assertEquals(entry.text.startsWith("Date:"), false, entry.text);
      assertEquals(entry.text.startsWith("On-demand tools"), false, entry.text);
    }

    // The code-mode session endpoint still serves the whole transcript
    // (context included): the split is in the endpoint, not in the store.
    const sessionRes = await json(base, `/api/sessions/${sessionId}/messages`);
    const session = await sessionRes.json() as {
      messages: Array<{ role: string }>;
    };
    assertEquals(
      session.messages.some((m) => m.role === "context"),
      true,
      "the model's context stays in the session transcript",
    );
    // The reply itself is part of both: the split is about the model's
    // machinery, not about hiding the answer.
    assertEquals(
      snapshot.entries.at(-1)?.text,
      "一覧を出しました。",
      "the answer is the conversation's last entry",
    );
  } finally {
    server.shutdown();
    await core.close();
  }
});

Deno.test("stella API: the conversation's stream carries only the conversation", async () => {
  // The stream is its own endpoint (`…/events`), not a filter of `/ws`: a
  // stella client learns nothing about tool progress, the panels or the
  // model's context, and no frame carries a session id (the socket belongs
  // to one conversation).
  const { core, faux, server, base } = await setup();
  try {
    await core.setProviderApiKey(faux.provider.id, "faux-key");
    core.setStellaVm({
      status: () =>
        Promise.resolve({ state: "running", vncPort: null, reason: "" }),
      start: () =>
        Promise.resolve({ state: "running", vncPort: 1, reason: "" }),
      stop: () => Promise.resolve(),
      vncPort: () => Promise.resolve(null),
    });
    const agentRes = await json(base, "/api/stella/agents", {
      method: "POST",
      body: JSON.stringify({ name: "Aide", role: "Help with the work." }),
    });
    const agent = await agentRes.json() as { id: string; name: string };
    const opened = await json(base, `/api/stella/conversations/${agent.id}`);
    assertEquals(opened.status, 200);

    faux.setResponses([fauxAssistantMessage("はい、承知しました。")]);
    const socket = new WebSocket(
      `ws://127.0.0.1:${server.addr.port}/api/stella/conversations/${agent.id}/events`,
    );
    const events: Array<Record<string, unknown>> = [];
    const done = new Promise<void>((resolve, reject) => {
      socket.onmessage = (e) => {
        const event = JSON.parse(String(e.data));
        // The heartbeat is transport-level (the client swallows it), as on
        // the session stream.
        if (event.type === "heartbeat") return;
        events.push(event);
        if (event.type === "agent_end") resolve();
      };
      socket.onerror = () => reject(new Error("socket failed"));
      socket.onopen = () => {
        void json(base, `/api/stella/conversations/${agent.id}/prompt`, {
          method: "POST",
          body: JSON.stringify({ text: "こんにちは" }),
        });
      };
    });

    await done;
    socket.close();

    const types = events.map((e) => e.type);
    assertEquals(types.includes("agent_start"), true);
    assertEquals(types.includes("agent_end"), true);
    assertEquals(types.includes("entry"), true);
    // None of the model's own traffic, and none of the surfaces this mode
    // does not have.
    for (
      const forbidden of [
        "message_start",
        "message_end",
        "tool_start",
        "tool_end",
        "todo",
        "task_start",
        "background_start",
        "goal_start",
        "messages_checkpoint",
      ]
    ) {
      assertEquals(types.includes(forbidden), false, forbidden);
    }
    // No frame names a session: the socket is the conversation.
    for (const event of events) {
      assertEquals("sessionId" in event, false, String(event.type));
    }
    // The entries are the words: the prompt and the answer.
    const entries = events.filter((e) => e.type === "entry").map((e) =>
      e.entry as { role: string; text: string }
    );
    assertEquals(entries[0]?.role, "user");
    assertEquals(entries[0]?.text, "こんにちは");
    const answer = entries.find((entry) => entry.role === "assistant");
    assertEquals(answer?.text, "はい、承知しました。");
  } finally {
    server.shutdown();
    await core.close();
  }
});

Deno.test("stella API: agents are listed, renamed and deleted with their conversation", async () => {
  const { core, faux, server, base } = await setup();
  try {
    await core.setProviderApiKey(faux.provider.id, "faux-key");
    core.setStellaVm({
      status: () =>
        Promise.resolve({ state: "running", vncPort: 1, reason: "" }),
      start: () =>
        Promise.resolve({ state: "running", vncPort: 1, reason: "" }),
      stop: () => Promise.resolve(),
      vncPort: () => Promise.resolve(1),
    });

    // The first read creates the starter agent (a fresh stella mode must
    // have someone to talk to), so the list is never empty.
    const initial = await json(base, "/api/stella/agents");
    const starter = await initial.json() as {
      agents: Array<{ id: string; name: string }>;
      defaultAgentId: string | null;
    };
    assertEquals(starter.agents.length, 1);
    assertEquals(starter.defaultAgentId, starter.agents[0]!.id);

    const created = await json(base, "/api/stella/agents", {
      method: "POST",
      body: JSON.stringify({ name: "Researcher", role: "Read papers." }),
    });
    const agent = await created.json() as { id: string };

    const listed = await json(base, "/api/stella/agents");
    const body = await listed.json() as {
      agents: Array<{ id: string; name: string }>;
      defaultAgentId: string | null;
    };
    assertEquals(body.agents.length, 2);
    // The agent just created is the one a fresh screen opens.
    assertEquals(body.defaultAgentId, agent.id);

    // A duplicate name is refused (the sidebar would be ambiguous).
    const duplicate = await json(base, "/api/stella/agents", {
      method: "POST",
      body: JSON.stringify({ name: "Researcher", role: "Again." }),
    });

    const renamed = await json(base, `/api/stella/agents/${agent.id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "Analyst" }),
    });
    assertEquals(renamed.status, 200);
    assertEquals(
      (await renamed.json() as { name: string }).name,
      "Analyst",
    );

    // Delete takes the conversation with it: an orphaned session would be
    // invisible in every list while still holding its messages.
    const session = await core.getOrCreateStellaSession(agent.id);
    const deleted = await json(base, `/api/stella/agents/${agent.id}`, {
      method: "DELETE",
    });
    assertEquals(deleted.status, 200);
    assertEquals(core.getSession(session.id), undefined);
    const after = await json(base, "/api/stella/agents");
    const remaining = await after.json() as { agents: Array<{ id: string }> };
    assertEquals(remaining.agents.map((a) => a.id), [starter.agents[0]!.id]);
    void duplicate;
  } finally {
    server.shutdown();
    await core.close();
  }
});

Deno.test("stella API: an agent's icon is uploaded, served and replaced", async () => {
  const { core, faux, server, base } = await setup();
  try {
    await core.setProviderApiKey(faux.provider.id, "faux-key");
    core.setStellaVm({
      status: () =>
        Promise.resolve({ state: "running", vncPort: 1, reason: "" }),
      start: () =>
        Promise.resolve({ state: "running", vncPort: 1, reason: "" }),
      stop: () => Promise.resolve(),
      vncPort: () => Promise.resolve(1),
    });

    const created = await json(base, "/api/stella/agents", {
      method: "POST",
      body: JSON.stringify({ name: "Aide", role: "Help." }),
    });
    const agent = await created.json() as { id: string; icon: string };
    // No picture yet: the client draws the initial instead.
    assertEquals(agent.icon, "");

    const upload = await json(base, `/api/stella/agents/${agent.id}/icon`, {
      method: "PUT",
      body: JSON.stringify({
        data: pngBase64(),
        mimeType: "image/png",
      }),
    });
    assertEquals(upload.status, 200);
    const withIcon = await upload.json() as { id: string; icon: string };
    assertEquals(withIcon.id, agent.id);
    assert(/^[0-9a-f]{12}\.png$/.test(withIcon.icon), withIcon.icon);

    // The row the list serves carries the same name, so the sidebar can draw
    // it without a second read.
    const listed = await json(base, "/api/stella/agents");
    const agents = (await listed.json() as {
      agents: Array<{ id: string; icon: string }>;
    }).agents;
    assertEquals(agents[0]?.icon, withIcon.icon);

    // The bytes are served with the stored content type and are cacheable:
    // the URL names one immutable file.
    const served = await fetch(
      `${base}/api/stella/agents/${agent.id}/icon/${withIcon.icon}`,
    );
    assertEquals(served.status, 200);
    assertEquals(served.headers.get("content-type"), "image/png");
    assertEquals(
      served.headers.get("cache-control"),
      "private, max-age=31536000, immutable",
    );
    assertEquals(
      (await served.arrayBuffer()).byteLength,
      MINI_PNG.byteLength,
    );

    // A replacement gets a NEW name: a cached URL must keep showing the
    // picture it showed.
    const replaced = await json(base, `/api/stella/agents/${agent.id}/icon`, {
      method: "PUT",
      body: JSON.stringify({
        data: pngBase64(),
        mimeType: "image/png",
      }),
    });
    const next = await replaced.json() as { icon: string };
    assert(next.icon !== withIcon.icon);
    assertEquals(
      (await fetch(
        `${base}/api/stella/agents/${agent.id}/icon/${next.icon}`,
      )).status,
      200,
    );
    // The old file is gone with it.
    assertEquals(
      (await fetch(
        `${base}/api/stella/agents/${agent.id}/icon/${withIcon.icon}`,
      )).status,
      404,
    );

    // Clearing returns the agent to its initial and removes the file.
    const cleared = await json(base, `/api/stella/agents/${agent.id}/icon`, {
      method: "DELETE",
    });
    assertEquals(cleared.status, 200);
    assertEquals((await cleared.json() as { icon: string }).icon, "");
    assertEquals(
      (await fetch(
        `${base}/api/stella/agents/${agent.id}/icon/${next.icon}`,
      )).status,
      404,
    );
  } finally {
    server.shutdown();
    await core.close();
  }
});

Deno.test("stella API: an icon upload is refused with the reason it failed", async () => {
  const { core, faux, server, base } = await setup();
  try {
    await core.setProviderApiKey(faux.provider.id, "faux-key");
    core.setStellaVm({
      status: () =>
        Promise.resolve({ state: "running", vncPort: 1, reason: "" }),
      start: () =>
        Promise.resolve({ state: "running", vncPort: 1, reason: "" }),
      stop: () => Promise.resolve(),
      vncPort: () => Promise.resolve(1),
    });
    const created = await json(base, "/api/stella/agents", {
      method: "POST",
      body: JSON.stringify({ name: "Aide", role: "Help." }),
    });
    const agent = await created.json() as { id: string };
    const path = `/api/stella/agents/${agent.id}/icon`;

    /** The error message of a refused upload. */
    const refusal = async (body: unknown): Promise<[number, string]> => {
      const response = await json(base, path, {
        method: "PUT",
        body: JSON.stringify(body),
      });
      const parsed = await response.json() as { error: string };
      return [response.status, parsed.error];
    };

    // A format icons cannot be (SVG is a document that can carry script).
    const [svgStatus, svgError] = await refusal({
      data: btoa("<svg/>"),
      mimeType: "image/svg+xml",
    });
    assertEquals(svgStatus, 400);
    assert(svgError.includes("PNG, JPEG, GIF, WebP or BMP"), svgError);

    // A body that is not the shape the route takes.
    assertEquals((await refusal({ mimeType: "image/png" }))[0], 400);
    assertEquals((await refusal({ data: pngBase64() }))[0], 400);

    // Content that is not the image its type claims: the browser's type is a
    // guess from the file name, so this is decided on the bytes.
    const [fakeStatus, fakeError] = await refusal({
      data: btoa("this is not a png"),
      mimeType: "image/png",
    });
    assertEquals(fakeStatus, 400);
    assert(fakeError.includes("not a PNG image"), fakeError);

    // Over the size cap, refused before it is decoded.
    const [bigStatus, bigError] = await refusal({
      data: "A".repeat(Math.ceil(512 * 1024 * 4 / 3) + 2048),
      mimeType: "image/png",
    });
    assertEquals(bigStatus, 400);
    assert(bigError.includes("too large"), bigError);

    // An unknown agent: the picture has nobody to belong to.
    const missing = await json(base, "/api/stella/agents/nope/icon", {
      method: "PUT",
      body: JSON.stringify({ data: pngBase64(), mimeType: "image/png" }),
    });
    assertEquals(missing.status, 404);

    // Nothing above changed the row.
    const listed = await json(base, "/api/stella/agents");
    const agents = (await listed.json() as {
      agents: Array<{ icon: string }>;
    }).agents;
    assertEquals(agents[0]?.icon, "");
  } finally {
    server.shutdown();
    await core.close();
  }
});

Deno.test("stella API: an icon URL answers only for a name that agent has", async () => {
  const { core, faux, server, base } = await setup();
  try {
    await core.setProviderApiKey(faux.provider.id, "faux-key");
    core.setStellaVm({
      status: () =>
        Promise.resolve({ state: "running", vncPort: 1, reason: "" }),
      start: () =>
        Promise.resolve({ state: "running", vncPort: 1, reason: "" }),
      stop: () => Promise.resolve(),
      vncPort: () => Promise.resolve(1),
    });
    const first = await (await json(base, "/api/stella/agents", {
      method: "POST",
      body: JSON.stringify({ name: "First", role: "r" }),
    })).json() as { id: string };
    const second = await (await json(base, "/api/stella/agents", {
      method: "POST",
      body: JSON.stringify({ name: "Second", role: "r" }),
    })).json() as { id: string };
    const withIcon = await (await json(
      base,
      `/api/stella/agents/${first.id}/icon`,
      {
        method: "PUT",
        body: JSON.stringify({ data: pngBase64(), mimeType: "image/png" }),
      },
    )).json() as { icon: string };

    // Another agent cannot claim it by naming the file...
    assertEquals(
      (await fetch(
        `${base}/api/stella/agents/${second.id}/icon/${withIcon.icon}`,
      )).status,
      404,
    );
    // ...nor can a name the store did not generate.
    assertEquals(
      (await fetch(
        `${base}/api/stella/agents/${first.id}/icon/000000000000.png`,
      )).status,
      404,
    );
    // An agent that does not exist is not a 404-only path either: the route
    // says the agent is missing rather than revealing whether a file exists.
    assertEquals(
      (await fetch(`${base}/api/stella/agents/nope/icon/${withIcon.icon}`))
        .status,
      404,
    );

    // Deleting the agent takes the file with it.
    await json(base, `/api/stella/agents/${first.id}`, { method: "DELETE" });
    assertEquals(
      (await fetch(
        `${base}/api/stella/agents/${first.id}/icon/${withIcon.icon}`,
      )).status,
      404,
    );
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

Deno.test("routine routes: list, enable, run and remove", async () => {
  const { core, server, base } = await setup();
  try {
    // Routines belong to a stella agent, so one has to exist first.
    const agent = core.createStellaAgent({ name: "Runner", role: "test" });
    const list = await json(base, `/api/stella/agents/${agent.id}/routines`);
    assertEquals(list.status, 200);
    assertEquals((await list.json() as { routines: unknown[] }).routines, []);

    // A routine created through the repo (the tool path) shows up in the
    // list, and the PATCH that toggles it answers the whole list.
    const repo = core.getRoutineRepo();
    const routine = repo.create({
      agentId: agent.id,
      name: "daily",
      prompt: "report",
      schedule: { kind: "daily", time: "09:00" },
    });
    const afterCreate = await json(
      base,
      `/api/stella/agents/${agent.id}/routines`,
    );
    assertEquals(
      (await afterCreate.json() as { routines: unknown[] }).routines.length,
      1,
    );

    const disabled = await json(base, `/api/routines/${routine.id}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: false }),
    });
    assertEquals(disabled.status, 200);
    assertEquals(
      (await disabled.json() as { routines: { enabled: boolean }[] })
        .routines[0]!.enabled,
      false,
    );

    // A bad `enabled` is a 400 (the helper, not a hand-rolled check).
    const badBody = await json(base, `/api/routines/${routine.id}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: "yes" }),
    });
    assertEquals(badBody.status, 400);

    const removed = await json(base, `/api/routines/${routine.id}`, {
      method: "DELETE",
    });
    assertEquals(removed.status, 200);
    assertEquals(
      (await removed.json() as { routines: unknown[] }).routines,
      [],
    );

    // An unknown id is a 404 on the stop/run actions too.
    const missing = await json(base, "/api/routines/nope/run", {
      method: "POST",
    });
    assertEquals(missing.status, 404);
  } finally {
    server.shutdown();
    await core.close();
  }
});
