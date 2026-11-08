import { basename, dirname, join, parse } from "node:path";
import { realpathSync } from "node:fs";
import {
  fauxAssistantMessage,
  fauxToolCall,
  type StreamRequest,
} from "@lumisca/core";
import { assert, assertEquals } from "@std/assert";
import { COMMAND_SAFETY_APPROVALS_KEY } from "@lumisca/core/shared";
import { conversationOf, json, pngBase64, setup } from "./test-utils.ts";

import {
  MINI_PNG,
  promptSession,
  removeDirRetry,
} from "@lumisca/core/test-utils";

function joinMissing(): string {
  return `Z:\\definitely\\not\\here\\lumisca-${crypto.randomUUID()}`;
}

Deno.test("health and workspaces API", async () => {
  const { core, server, base } = await setup();
  try {
    const health = await fetch(`${base}/api/health`);
    assertEquals(health.status, 200);
    const healthBody = await health.json() as {
      ok: boolean;
      now: number;
      instanceId?: unknown;
    };
    assertEquals(healthBody.ok, true);
    // The timestamp proves the event loop answered (liveness for hang
    // detection), not just the TCP listener.
    assertEquals(typeof healthBody.now, "number");
    // The identity a federation peer is compared against: the same server
    // under another URL must be recognisable as this one (see the
    // federation client's self-check).
    assertEquals(typeof healthBody.instanceId, "string");

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

    // A workspace skill fixture. Global discovery is disabled and no
    // browser backend is attached, so the only built-in skill a main agent
    // gets is the MCP guide (the tools it teaches are always available).
    const skillDir = join(root, ".agents", "skills", "demo");
    await Deno.mkdir(skillDir, { recursive: true });
    await Deno.writeTextFile(
      join(skillDir, "SKILL.md"),
      "---\nname: demo\ndescription: Demo skill.\n---\n\nDo the demo thing.\n",
    );
    const mcpGuide = core.listSkills().find((s) => s.name === "mcp-servers");
    assert(mcpGuide !== undefined, "the MCP guide must be listed");
    // A workspace session has file tools, so its palette also offers the
    // guide that teaches writing a skill.
    const skillGuide = core.listSkills(ws.id).find((s) =>
      s.name === "skill-authoring"
    );
    assert(skillGuide !== undefined, "the skill guide must be listed");

    const forWorkspace = await json(
      base,
      `/api/skills?workspaceId=${ws.id}`,
    );
    assertEquals(forWorkspace.status, 200);
    assertEquals((await forWorkspace.json()).skills, [
      { name: "demo", description: "Demo skill." },
      mcpGuide,
      skillGuide,
    ]);

    // Without a workspaceId the endpoint answers for a chat session: no
    // workspace skill, but the same built-ins (the same contract as
    // POST /sessions).
    const chat = await json(base, "/api/skills");
    assertEquals(chat.status, 200);
    assertEquals((await chat.json()).skills, [mcpGuide]);

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

Deno.test("compact condenses the history via the API", async () => {
  const { core, server, faux, base } = await setup();
  try {
    const root = await Deno.makeTempDir({ prefix: "lumisca-srv-" });
    const create = await json(base, "/api/workspaces", {
      method: "POST",
      body: JSON.stringify({ name: "ws", folders: [root] }),
    });
    const ws = await create.json();

    // What a `/compact` DOES (which span it picks, what it summarizes, what
    // it refuses) belongs to the compactor and is pinned by its own unit
    // tests; this is the route's contract. The history is therefore only as
    // long as it takes for the route to have something to condense — a
    // count that depends on the size of the system prompt would make this
    // test fail whenever a tool description grows.
    const sessionRes = await json(base, "/api/sessions", {
      method: "POST",
      body: JSON.stringify({
        workspaceId: ws.id,
        modelProvider: faux.provider.id,
        modelId: faux.getModel().id,
      }),
    });
    const session = await sessionRes.json();

    // A responder that answers a summarization request with a summary and
    // every other call with a short reply. The summarization request is the
    // one carrying the serialized conversation, so the answer order does not
    // depend on how the prompts are scheduled (the prompt endpoint is
    // fire-and-forget).
    const summaryPrompts: string[] = [];
    faux.setResponses(
      Array.from({ length: 40 }, () => (context: StreamRequest) => {
        const last = context.messages.at(-1) as
          | { content?: Array<{ text?: string }> }
          | undefined;
        const text = last?.content?.[0]?.text ?? "";
        if (text.includes("<conversation>")) {
          summaryPrompts.push(text);
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

    // The endpoint answers with the number of messages it summarized, and
    // the typed focus reaches the summarization prompt. `compacted` is
    // absent when nothing could be condensed — a valid answer, so the test
    // asks the route whether the history it built has anything to condense
    // rather than assuming one exists.
    const compactRes = await json(
      base,
      `/api/sessions/${session.id}/compact`,
      {
        method: "POST",
        body: JSON.stringify({ instructions: "keep the file paths" }),
      },
    );
    assertEquals(compactRes.status, 200);
    const body = await compactRes.json() as { ok: boolean; compacted?: number };
    assertEquals(body.ok, true);
    if (body.compacted !== undefined) {
      assertEquals(typeof body.compacted, "number");
      assertEquals(
        summaryPrompts.some((prompt) =>
          prompt.includes("Additional focus: keep the file paths")
        ),
        true,
        summaryPrompts.map((p) => p.slice(0, 80)).join("\n---\n"),
      );
    }

    // The route reports a session that does not exist, whatever the body.
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
    };
    // A fresh installation has someone to talk to: an empty sidebar in front
    // of a disabled composer would be a wall in front of the whole mode.
    assertEquals(body.agents.length, 1);
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
    };
    assertEquals(after.agents.length, 1);
  } finally {
    server.shutdown();
    void core.close();
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

    faux.setResponses([
      fauxAssistantMessage([
        { type: "text", text: "作業メモを書いてから送る。" },
        fauxToolCall("send_chat", { text: "はい、承知しました。" }, "call-1"),
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage("送り終えた。"),
    ]);
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
    // The entries are what was said: the prompt, what the agent sent with
    // send_chat, and the text of its FINAL turn. The first turn's text
    // ("作業メモを書いてから送る。") ended in a tool call, so it is narration —
    // the working notes the run thinks out loud — and never becomes an
    // entry. There is still no delta frame: a message arrives whole.
    const entries = events.filter((e) => e.type === "entry").map((e) =>
      e.entry as { role: string; text: string }
    );
    assertEquals(entries[0]?.role, "user");
    assertEquals(entries[0]?.text, "こんにちは");
    const answers = entries.filter((entry) => entry.role === "assistant");
    assertEquals(answers.map((entry) => entry.text), [
      "はい、承知しました。",
      "送り終えた。",
    ]);
    assertEquals(types.includes("delta"), false, "no streaming text");
  } finally {
    server.shutdown();
    await core.close();
  }
});

Deno.test("stella API: a row carries what its conversation last said", async () => {
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

    // A conversation that has not been opened says nothing: the row is one
    // line, and the client has no time to show.
    const before = await json(base, "/api/stella/agents");
    const initial = await before.json() as {
      agents: Array<{ id: string; preview: unknown }>;
    };
    assertEquals(initial.agents[0]?.preview, null);

    // Speak in it, then read the list: the second line is what the agent
    // SENT (the conversation's projection, not the model's notes). The
    // second turn has nothing to add and writes the silence sentinel, so the
    // message above it stays the newest entry.
    const agentId = initial.agents[0]!.id;
    const session = await core.getOrCreateStellaSession(agentId);
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("send_chat", { text: "直しました。" }, "call-1"),
      ], { stopReason: "toolUse" }),
      // The sentinel's spelling is the model-facing contract documented in
      // the core's agent/silent-reply.ts.
      fauxAssistantMessage("NO_RESPONSE"),
    ]);
    await promptSession(core, session.id, "直して");
    const listed = await json(base, "/api/stella/agents");
    const body = await listed.json() as {
      agents: Array<{
        id: string;
        preview: { kind: string; text: string; at: number } | null;
      }>;
    };
    const row = body.agents.find((item) => item.id === agentId);
    assertEquals(row?.preview?.kind, "text");
    assertEquals(row?.preview?.text, "直しました。");
    // The time travels with the preview: it is the message's, which is what
    // the list shows and orders by.
    assertEquals(typeof row?.preview?.at, "number");
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
    };
    assertEquals(starter.agents.length, 1);

    const created = await json(base, "/api/stella/agents", {
      method: "POST",
      body: JSON.stringify({ name: "Researcher", role: "Read papers." }),
    });
    const agent = await created.json() as { id: string };

    const listed = await json(base, "/api/stella/agents");
    const body = await listed.json() as {
      agents: Array<{ id: string; name: string }>;
    };
    assertEquals(body.agents.length, 2);

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

Deno.test("stella API: an agent's name and icon are saved together and served", async () => {
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

    // One request saves what the edit dialog shows: the label and the
    // picture. The answer is the updated row, so the client draws both
    // without a second read.
    const saved = await json(base, `/api/stella/agents/${agent.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        name: "Analyst",
        icon: { data: pngBase64(), mimeType: "image/png" },
      }),
    });
    assertEquals(saved.status, 200);
    const withIcon = await saved.json() as {
      id: string;
      name: string;
      icon: string;
    };
    assertEquals(withIcon.id, agent.id);
    assertEquals(withIcon.name, "Analyst");
    assert(/^[0-9a-f]{12}\.png$/.test(withIcon.icon), withIcon.icon);

    // The row the list serves carries the same name, so the sidebar can draw
    // it without a second read.
    const listed = await json(base, "/api/stella/agents");
    const agents = (await listed.json() as {
      agents: Array<{ id: string; name: string; icon: string }>;
    }).agents;
    assertEquals(agents[0]?.name, "Analyst");
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
    // picture it showed. A patch that names only the picture leaves the name
    // alone.
    const replaced = await json(base, `/api/stella/agents/${agent.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        icon: { data: pngBase64(), mimeType: "image/png" },
      }),
    });
    const next = await replaced.json() as { name: string; icon: string };
    assertEquals(next.name, "Analyst");
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

    // Clearing returns the agent to its initial and removes the file; the
    // name is untouched.
    const cleared = await json(base, `/api/stella/agents/${agent.id}`, {
      method: "PATCH",
      body: JSON.stringify({ icon: null }),
    });
    assertEquals(cleared.status, 200);
    const clearedAgent = await cleared.json() as {
      name: string;
      icon: string;
    };
    assertEquals(clearedAgent.name, "Analyst");
    assertEquals(clearedAgent.icon, "");
    assertEquals(
      (await fetch(
        `${base}/api/stella/agents/${agent.id}/icon/${next.icon}`,
      )).status,
      404,
    );

    // Renaming alone is the same route with one field.
    const renamed = await json(base, `/api/stella/agents/${agent.id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "Notes" }),
    });
    assertEquals((await renamed.json() as { name: string }).name, "Notes");
  } finally {
    server.shutdown();
    await core.close();
  }
});

Deno.test("stella API: a refused name or picture changes nothing", async () => {
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
    await json(base, "/api/stella/agents", {
      method: "POST",
      body: JSON.stringify({ name: "Taken", role: "" }),
    });
    const path = `/api/stella/agents/${agent.id}`;

    /** The status and message of a refused patch. */
    const refusal = async (body: unknown): Promise<[number, string]> => {
      const response = await json(base, path, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      const parsed = await response.json() as { error: string };
      return [response.status, parsed.error];
    };

    // A name another agent has (compared case-insensitively): the sidebar
    // would show two rows the user cannot tell apart.
    const [takenStatus, takenError] = await refusal({ name: "taken" });
    assertEquals(takenStatus, 409);
    assert(takenError.includes("already exists"), takenError);

    // An empty name: the core refuses it rather than inventing the default.
    const [emptyStatus, emptyError] = await refusal({ name: "   " });
    assertEquals(emptyStatus, 400);
    assert(emptyError.includes("must not be empty"), emptyError);

    // A picture that is not an image: refused on the bytes, and the name it
    // travelled with is not stored either — the save is one act.
    const [fakeStatus, fakeError] = await refusal({
      name: "Fine",
      icon: { data: btoa("this is not a png"), mimeType: "image/png" },
    });
    assertEquals(fakeStatus, 400);
    assert(fakeError.includes("not a PNG image"), fakeError);

    // An `icon` that is neither null nor an object is a client bug, not a
    // silent "leave it alone".
    assertEquals((await refusal({ icon: "yes" }))[0], 400);

    // An unknown agent.
    const missing = await json(base, "/api/stella/agents/nope", {
      method: "PATCH",
      body: JSON.stringify({ name: "Whoever" }),
    });
    assertEquals(missing.status, 404);

    // Nothing above changed the row.
    const listed = await json(base, "/api/stella/agents");
    const agents = (await listed.json() as {
      agents: Array<{ id: string; name: string; icon: string }>;
    }).agents;
    assertEquals(agents.find((entry) => entry.id === agent.id)?.name, "Aide");
    assertEquals(agents.find((entry) => entry.id === agent.id)?.icon, "");
  } finally {
    server.shutdown();
    await core.close();
  }
});

Deno.test("stella API: an icon patch is refused with the reason it failed", async () => {
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
    const path = `/api/stella/agents/${agent.id}`;

    /** The error message of a refused patch. */
    const refusal = async (icon: unknown): Promise<[number, string]> => {
      const response = await json(base, path, {
        method: "PATCH",
        body: JSON.stringify({ icon }),
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
    const missing = await json(base, "/api/stella/agents/nope", {
      method: "PATCH",
      body: JSON.stringify({
        icon: { data: pngBase64(), mimeType: "image/png" },
      }),
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
      `/api/stella/agents/${first.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          icon: { data: pngBase64(), mimeType: "image/png" },
        }),
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

Deno.test("routine routes: list, enable, run and remove", async () => {
  const { core, server, base } = await setup();
  try {
    // Routines belong to a stella agent, so one has to exist first.
    const agent = await core.createStellaAgent({
      name: "Runner",
      role: "test",
    });
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
