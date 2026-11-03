import { basename, join } from "node:path";

import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@lumisca/core";
import { assert, assertEquals } from "@std/assert";
import { LumiscaCore } from "@lumisca/core";

import { type AppOptions, startServer } from "./app.ts";

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
Deno.test("the event stream batches a reply's deltas into few frames", async () => {
  // A run streams one text delta per token. Forwarding each as its own frame
  // is free on a loopback socket and expensive on a link with a real round
  // trip: the frames arrive as bursts and the reply renders in jumps. The
  // batch must keep the text whole and in order, and it must not merge two
  // sessions (one socket carries every open tab).
  const { core, server, faux, base } = await setup(undefined, {
    deltaFlushMs: 5,
  });
  try {
    const root = await Deno.makeTempDir({ prefix: "lumisca-srv-" });
    const ws = await (await json(base, "/api/workspaces", {
      method: "POST",
      body: JSON.stringify({ name: "ws", folders: [root] }),
    })).json();
    // Many text blocks = many text deltas (the faux stream emits one delta
    // per text block).
    const words = Array.from({ length: 120 }, (_, i) => `w${i} `);
    faux.setResponses([
      fauxAssistantMessage(words.map((text) => ({ type: "text", text }))),
    ]);
    const session = await (await json(base, "/api/sessions", {
      method: "POST",
      body: JSON.stringify({
        workspaceId: ws.id,
        modelProvider: faux.provider.id,
        modelId: faux.getModel().id,
      }),
    })).json();

    const socket = new WebSocket(`ws://127.0.0.1:${server.addr.port}/ws`);
    const frames: Array<Record<string, unknown>> = [];
    await new Promise<void>((resolve) => {
      socket.onmessage = (e) => {
        const frame = JSON.parse(String(e.data)) as Record<string, unknown>;
        if (frame.type === "heartbeat") return;
        frames.push(frame);
        if (frame.type === "agent_end") resolve();
      };
      socket.onopen = () => {
        void json(base, `/api/sessions/${session.id}/prompt`, {
          method: "POST",
          body: JSON.stringify({ text: "Hi" }),
        });
      };
    });
    socket.close();

    const deltas = frames.filter((f) => f.type === "message_delta");
    assert(
      deltas.length < words.length / 4,
      `${deltas.length} delta frames for ${words.length} tokens: not batched`,
    );
    // The frames carry the session they belong to (a batch is one
    // transcript's text), the text in order, and the count they cover.
    const text = deltas.map((f) => f.delta as string).join("");
    assertEquals(text, words.join(""));
    assertEquals(deltas.every((f) => f.sessionId === session.id), true);
    assertEquals(
      deltas.reduce((sum, f) => sum + (f.events as number), 0),
      words.length,
    );

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
    // re-reads the snapshot when it jumps (see LumiscaCore's revision). A
    // batched delta frame covers several events at once, so it also says
    // how many — the count must be continuous from the client's point of
    // view, or every batch would be read as lost frames.
    const tracked = events.filter(
      (e) => e.sessionId === session.id && typeof e.rev === "number",
    );
    assertEquals(tracked.length > 0, true);
    let expected = 1;
    for (const frame of tracked) {
      assertEquals(
        frame.rev,
        expected + (frame.events as number ?? 1) - 1,
        `revision ${frame.rev} does not follow ${expected - 1}`,
      );
      expected = (frame.rev as number) + 1;
    }

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

Deno.test("cors and websocket reject other local ports (authority check)", async () => {
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

    // The page's scheme is the browser's hop to this server, not part of
    // its identity: a TLS front end sends https while this server sees the
    // same host over http. The CORS answer must follow the same rule as
    // the WebSocket guard, or half of a remote install breaks at a time.
    const viaTls = base.replace("http://", "https://");
    const tlsPage = await fetch(`${base}/api/health`, {
      headers: { Origin: viaTls },
    });
    assertEquals(
      tlsPage.headers.get("access-control-allow-origin"),
      viaTls,
      "the same host over https is this server behind a TLS front end",
    );
  } finally {
    server.shutdown();
    core.close();
  }
});
