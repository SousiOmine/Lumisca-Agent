import { realpathSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@lumisca/core";
import { TOOL_READ } from "@lumisca/core/shared";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { promptSession, removeDirRetry } from "../core/test-utils.ts";
import { disposeServer } from "./app.ts";
import {
  createShareHost,
  type LocalGrant,
  Mount,
  runCall,
} from "./share-host.ts";
import { setup } from "./test-utils.ts";

const SESSION = "sess-lend";

/** A temp folder, resolved so macOS's /var symlink does not make the sandbox's
 * realpath differ from the path the test wrote. */
function folder(): string {
  return realpathSync.native(Deno.makeTempDirSync({ prefix: "lumisca-lend-" }));
}

function grant(path: string, overrides: Partial<LocalGrant> = {}): LocalGrant {
  return {
    id: "g1",
    sessionId: SESSION,
    path,
    write: true,
    exec: true,
    ...overrides,
  };
}

async function until(check: () => boolean, what: string): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > 3000) throw new Error(`timed out: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

Deno.test("the lending process serves a folder over the socket", async () => {
  const { core, server, base } = setup();
  const root = folder();
  const lender = createShareHost({ retryMs: 10 });
  try {
    await Deno.writeTextFile(
      join(root, "a.txt"),
      "hello from the lent folder\n",
    );
    await Deno.mkdir(join(root, "src"));
    await Deno.writeTextFile(join(root, "src", "b.ts"), "one\ntwo\n");

    lender.command(JSON.stringify({ type: "hello", url: base, token: "" }));
    lender.command(JSON.stringify({ type: "grants", grants: [grant(root)] }));
    await until(
      () => core.shares.grantsFor(SESSION).length === 1,
      "the loan to reach the server",
    );
    // The name the model will use comes from the folder, not the grant id.
    assertEquals(
      core.shares.sharesFor(SESSION)[0]?.name,
      root
        .split(/[\\/]+/)
        .pop()
        ?.toLowerCase()
        .replace(/[^a-z0-9]+/g, "-"),
    );

    const read = await core.shares.call("g1", "readText", {
      path: ["a.txt"],
      maxBytes: 1024,
    });
    assertEquals(read.text, "hello from the lent folder\n");
    assertEquals(read.size, 27);

    const stat = await core.shares.call("g1", "stat", { path: ["missing"] });
    assertEquals(stat, null);
    const list = await core.shares.call("g1", "listDir", { path: [] });
    assert(list.some((entry) => entry.name === "src" && entry.isDirectory));
    const ranges = await core.shares.call("g1", "readRanges", {
      path: ["src", "b.ts"],
      ranges: [{ from: 2, to: 2 }],
    });
    assertEquals(ranges.lines, ["two"]);

    await core.shares.call("g1", "writeText", {
      path: ["written.txt"],
      text: "from the agent\n",
      private: false,
    });
    assertEquals(
      await Deno.readTextFile(join(root, "written.txt")),
      "from the agent\n",
    );

    const exec = await core.shares.call("g1", "exec", {
      path: [],
      command: "echo lent-shell",
      timeoutSec: 20,
      maxOutputChars: 4096,
    });
    assertEquals(exec.exitCode, 0);
    assert(exec.stdout.includes("lent-shell"), exec.stdout);
  } finally {
    lender.close();
    disposeServer(server);
    server.shutdown();
    await core.close();
    await removeDirRetry(root);
  }
});

Deno.test("a read-only loan refuses to write, in the process that holds the disk", async () => {
  const { core, server, base } = setup();
  const root = folder();
  const lender = createShareHost({ retryMs: 10 });
  try {
    await Deno.writeTextFile(join(root, "a.txt"), "x\n");
    lender.command(JSON.stringify({ type: "hello", url: base, token: "" }));
    lender.command(
      JSON.stringify({
        type: "grants",
        grants: [grant(root, { write: false, exec: false })],
      }),
    );
    await until(
      () => core.shares.grantsFor(SESSION).length === 1,
      "the loan to reach the server",
    );
    await assertRejects(
      () =>
        core.shares.call("g1", "writeText", {
          path: ["a.txt"],
          text: "changed",
          private: false,
        }),
      Error,
      "read-only",
    );
    assertEquals(await Deno.readTextFile(join(root, "a.txt")), "x\n");
    await assertRejects(
      () =>
        core.shares.call("g1", "exec", {
          path: [],
          command: "echo no",
          timeoutSec: 5,
          maxOutputChars: 100,
        }),
      Error,
      "without command access",
    );
  } finally {
    lender.close();
    disposeServer(server);
    server.shutdown();
    await core.close();
    await removeDirRetry(root);
  }
});

Deno.test("a call cannot climb out of the lent folder", async () => {
  const root = folder();
  const outside = `${root}-outside`;
  await Deno.mkdir(outside, { recursive: true });
  try {
    const mount = new Mount(grant(root));
    await assertRejects(
      () => mount.absolute(["..", "secret.txt"]),
      Error,
      "outside",
    );
    await assertRejects(
      () => runCall(mount, { op: "readText", path: ["..", "x"], maxBytes: 10 }),
      Error,
      "outside",
    );
  } finally {
    await removeDirRetry(root);
    await removeDirRetry(outside);
  }
});

Deno.test("a whole-file read larger than one frame is refused with a next step", async () => {
  const root = folder();
  try {
    await Deno.writeTextFile(join(root, "big.txt"), "0123456789");
    const mount = new Mount(grant(root));
    await assertRejects(
      () => runCall(mount, { op: "readText", path: ["big.txt"], maxBytes: 4 }),
      Error,
      "line range",
    );
  } finally {
    await removeDirRetry(root);
  }
});

Deno.test("a withdrawn loan stops answering", async () => {
  const { core, server, base } = setup();
  const root = folder();
  const lender = createShareHost({ retryMs: 10 });
  try {
    lender.command(JSON.stringify({ type: "hello", url: base, token: "" }));
    lender.command(JSON.stringify({ type: "grants", grants: [grant(root)] }));
    await until(
      () => core.shares.grantsFor(SESSION).length === 1,
      "the loan to reach the server",
    );
    lender.command(JSON.stringify({ type: "grants", grants: [] }));
    await until(
      () => core.shares.grantsFor(SESSION).length === 0,
      "the withdrawal",
    );
    // The server refuses before a frame is even sent.
    await assertRejects(
      () => core.shares.call("g1", "stat", { path: [] }),
      Error,
      "no longer lent",
    );
  } finally {
    lender.close();
    disposeServer(server);
    server.shutdown();
    await core.close();
    await removeDirRetry(root);
  }
});

Deno.test("a loan ends after 30 idle minutes, and an access restarts the clock", async () => {
  const { core, server, base } = setup();
  const root = folder();
  // The production deadline is half an hour; the rule is the same one at any
  // length, so the test shrinks it instead of waiting.
  const lender = createShareHost({ retryMs: 10, idleMs: 600 });
  const sleep = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));
  try {
    lender.command(JSON.stringify({ type: "hello", url: base, token: "" }));
    lender.command(JSON.stringify({ type: "grants", grants: [grant(root)] }));
    await until(
      () => core.shares.grantsFor(SESSION).length === 1,
      "the loan to reach the server",
    );

    // An access part-way through the loan pushes the deadline out: the loan
    // is still there 600ms after it was lent.
    await sleep(300);
    await core.shares.call("g1", "stat", { path: [] });
    await sleep(300);
    assertEquals(core.shares.grantsFor(SESSION).length, 1);

    // …and gone 600ms after that access, with no withdrawal from the shell.
    // The lender drops it from its own list, not only from the server's
    // filtered view — the UI reads the list it announced.
    await until(
      () =>
        core.shares.grantsFor(SESSION).length === 0 &&
        core.shares.connections()[0]!.grants.length === 0,
      "the idle loan to expire",
    );
    await assertRejects(
      () => core.shares.call("g1", "stat", { path: [] }),
      Error,
      "no longer lent",
    );
  } finally {
    lender.close();
    disposeServer(server);
    server.shutdown();
    await core.close();
    await removeDirRetry(root);
  }
});

Deno.test("a line the process cannot read is ignored", () => {
  const lender = createShareHost({ retryMs: 10 });
  try {
    lender.command("not json");
    lender.command(JSON.stringify({ type: "hello" }));
    lender.command(JSON.stringify({ type: "grants", grants: [{ id: 1 }] }));
  } finally {
    lender.close();
  }
});

Deno.test("an agent's read reaches the folder through the whole chain", async () => {
  const { core, server, base, faux } = setup();
  const workspace = folder();
  const lent = folder();
  const lender = createShareHost({ retryMs: 10 });
  try {
    await Deno.writeTextFile(join(lent, "notes.md"), "lent notes\n");
    const ws = await core.createWorkspace("ws", [workspace]);
    const session = await core.createSession({
      workspaceId: ws.id,
      modelProvider: faux.provider.id,
      modelId: faux.getModel().id,
    });
    lender.command(JSON.stringify({ type: "hello", url: base, token: "" }));
    lender.command(
      JSON.stringify({
        type: "grants",
        grants: [grant(lent, { id: "g1", sessionId: session.id, exec: false })],
      }),
    );
    await until(
      () => core.shares.grantsFor(session.id).length === 1,
      "the loan to reach the server",
    );
    const name = core.shares.sharesFor(session.id)[0]!.name;

    // The model is told about the loan before it decides anything: the
    // publication is the only place the paths are named.
    faux.setResponses([
      fauxAssistantMessage([
        fauxText("Reading it."),
        fauxToolCall(TOOL_READ, { path: `/lend/${name}/notes.md` }),
      ]),
      fauxAssistantMessage("Done."),
    ]);
    await promptSession(core, session.id, "read the notes the user lent");

    const messages = core.getAgent(session.id)!.messages;
    const published = messages.find(
      (message) => message.role === "context" && message.provider === "shares",
    );
    assert(published !== undefined, "no lent-folders context was published");
    if (published.role === "context") {
      assert(published.body.includes(`/lend/${name}`), published.body);
      assert(published.body.includes("read-write"), published.body);
      assert(published.body.includes("no commands"), published.body);
    }
    // …and the read itself went to the user's computer: the tool result is
    // the file's own text, not a refusal.
    const result = messages.find((message) => message.role === "toolResult");
    assert(result !== undefined, "the read produced no tool result");
    assert(
      JSON.stringify(result).includes("lent notes"),
      JSON.stringify(result),
    );

    // Withdrawing the loan tells the conversation, before the next run.
    lender.command(JSON.stringify({ type: "grants", grants: [] }));
    await until(
      () => core.shares.grantsFor(session.id).length === 0,
      "the withdrawal",
    );
    faux.setResponses([fauxAssistantMessage("Understood.")]);
    await promptSession(core, session.id, "and now?");
    const ended = core
      .getAgent(session.id)!
      .messages.filter(
        (message) =>
          message.role === "context" && message.provider === "shares",
      )
      .at(-1);
    assert(ended !== undefined);
    if (ended.role === "context") {
      assert(ended.body.includes("no longer available"), ended.body);
    }
  } finally {
    lender.close();
    disposeServer(server);
    server.shutdown();
    await core.close();
    await removeDirRetry(workspace);
    await removeDirRetry(lent);
  }
});
