import { basename } from "node:path";
import { assert, assertEquals } from "@std/assert";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { createAsyncBashTools } from "./background.ts";
import {
  BACKGROUND_TAIL_LIMIT,
  type BackgroundCommandDone,
  BackgroundProcessManager,
  formatBackgroundNotification,
  MAX_BACKGROUND_COMMANDS,
  trimIncompleteUtf8,
} from "./background.ts";
import type { ClientEvent } from "../types/event.ts";
import { Sandbox } from "../workspace/sandbox.ts";
import { LumiscaCore } from "../mod.ts";

/** Cross-platform commands. The Windows shell has no sleep; ping is the
 * classic stand-in. */
const longCommand = Deno.build.os === "windows"
  ? "ping -n 60 127.0.0.1 > $null"
  : "sleep 60";
const briefCommand = Deno.build.os === "windows"
  ? "ping -n 2 127.0.0.1 > $null; echo done"
  : "sleep 1; echo done";
const startContractCommand = Deno.build.os === "windows"
  ? "ping -n 3 127.0.0.1 > $null; echo done"
  : "sleep 2; echo done";
const linesCommand = Deno.build.os === "windows"
  ? "echo start; echo line1; echo line2"
  : "echo start; echo line1; echo line2";

/** Resolve when the next command completes (bounded so a hang fails the
 * test instead of running forever). */
function waitForExit(
  manager: BackgroundProcessManager,
  timeoutMs = 15000,
): Promise<BackgroundCommandDone> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("timed out waiting for command exit")),
      timeoutMs,
    );
    const unsubscribe = manager.onExit((done) => {
      clearTimeout(timer);
      unsubscribe();
      resolve(done);
    });
  });
}

/** Resolve when the collected lifecycle events contain the command's end
 * event (bounded so a hang fails the test instead of running forever). */
function waitForEndEvent(
  events: ClientEvent[],
  timeoutMs = 15000,
): Promise<Extract<ClientEvent, { type: "background_end" }>> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      const end = events.find(
        (e): e is Extract<ClientEvent, { type: "background_end" }> =>
          e.type === "background_end",
      );
      if (end !== undefined) {
        resolve(end);
        return;
      }
      if (Date.now() > deadline) {
        reject(
          new Error(
            `timed out waiting for background_end; events: ${
              JSON.stringify(events)
            }`,
          ),
        );
        return;
      }
      setTimeout(poll, 20);
    };
    poll();
  });
}

/** Remove a test directory, retrying briefly while a killed process still
 * holds it. On Windows a force-killed descendant keeps its working-
 * directory handle for a beat after the kill, so an immediate recursive
 * delete can fail with EBUSY even though every process is already dead. */
async function removeTreeRetry(root: string): Promise<void> {
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      await Deno.remove(root, { recursive: true });
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

function toolText(
  result: { content: { type: "text" | "image"; text?: string }[] },
): string {
  return result.content.map((c) => (c.type === "text" ? (c.text ?? "") : ""))
    .join("");
}

// --- manager ---------------------------------------------------------------

Deno.test("start returns immediately and notifies on completion", async () => {
  const manager = new BackgroundProcessManager();
  const exitPromise = waitForExit(manager);
  // Do not await: start() has a synchronous contract and must return while a
  // command whose runtime comfortably exceeds Windows process startup is live.
  const { commandId } = manager.start({
    cwd: Deno.cwd(),
    command: startContractCommand,
  });
  assert(manager.get(commandId)!.state === "running");
  const done = await exitPromise;
  assertEquals(done.commandId, commandId);
  assertEquals(done.reason, "exited");
  assertEquals(done.exitCode, 0);
  assert(done.tail.includes("done"), `tail missing output: ${done.tail}`);
  assertEquals(manager.get(commandId)!.state, "finished");
});

Deno.test("lifecycle events announce start, output deltas and end", async () => {
  const events: ClientEvent[] = [];
  const manager = new BackgroundProcessManager({
    sessionId: "s1",
    emit: (event) => events.push(event),
  });
  const startedAt = Date.now();
  const { commandId } = await manager.start({
    cwd: Deno.cwd(),
    command: linesCommand,
  });
  // start() must announce the command synchronously, before it can finish.
  const start = events[0];
  assertEquals(start?.type, "background_start");
  if (start?.type !== "background_start") return;
  assertEquals(start.sessionId, "s1");
  assertEquals(start.commandId, commandId);
  assertEquals(start.command, linesCommand);
  assertEquals(start.cwd, Deno.cwd());
  assert(start.pid > 0, `pid must be positive: ${start.pid}`);
  assert(Math.abs(start.startedAt - startedAt) < 5000);

  const end = await waitForEndEvent(events);
  assertEquals(end.sessionId, "s1");
  assertEquals(end.commandId, commandId);
  assertEquals(end.state, "finished");
  assertEquals(end.exitCode, 0);
  assert(end.finishedAt >= start.startedAt);
  assert(end.tail.includes("line2"), `tail missing output: ${end.tail}`);

  // Deltas carry the decoded output and must arrive between start and end.
  const deltas = events.filter(
    (e): e is Extract<ClientEvent, { type: "background_delta" }> =>
      e.type === "background_delta",
  );
  assert(deltas.length > 0, "no background_delta events were emitted");
  const joined = deltas.map((d) => d.delta).join("");
  assert(joined.includes("line1"), `deltas missing output: ${joined}`);
  assert(
    events.findIndex((e) => e.type === "background_start") <
      events.findIndex((e) => e.type === "background_delta"),
    "deltas must follow the start event",
  );
  assert(
    events.findIndex((e) => e.type === "background_delta") <
      events.findIndex((e) => e.type === "background_end"),
    "end must follow the deltas",
  );
});

Deno.test("kill announces a killed end event", async () => {
  const events: ClientEvent[] = [];
  const manager = new BackgroundProcessManager({
    sessionId: "s1",
    emit: (event) => events.push(event),
  });
  const { commandId } = await manager.start({
    cwd: Deno.cwd(),
    command: longCommand,
  });
  // Let the shell spawn before tearing it down (taskkill needs a live pid).
  await new Promise((resolve) => setTimeout(resolve, 500));
  await manager.kill(commandId);
  const end = await waitForEndEvent(events);
  assertEquals(end.commandId, commandId);
  assertEquals(end.state, "killed");
  // The exit code of a killed process is OS-dependent (often a non-zero
  // code on Windows), so only the state is asserted.
  assert(
    end.exitCode === undefined || typeof end.exitCode === "number",
    `exitCode must be a number or undefined: ${end.exitCode}`,
  );
});

Deno.test("status reports state, exit code and output tail", async () => {
  const manager = new BackgroundProcessManager();
  const exitPromise = waitForExit(manager);
  const { commandId } = await manager.start({
    cwd: Deno.cwd(),
    command: briefCommand,
  });
  const tailWhileRunning = await manager.tail(commandId);
  assert(manager.get(commandId)!.state === "running");
  await exitPromise;
  const info = manager.get(commandId)!;
  assertEquals(info.state, "finished");
  assertEquals(info.exitCode, 0);
  const tail = (await manager.tail(commandId)) ?? "";
  assert(tail.includes("done"), `tail missing output: ${tail}`);
  assert(tailWhileRunning !== undefined);
});

Deno.test("per-command env vars are passed and override the manager-level env", async () => {
  const manager = new BackgroundProcessManager({
    env: { LUMISCA_TEST_ENV: "manager-level" },
  });
  const exitPromise = waitForExit(manager);
  const echo = Deno.build.os === "windows"
    ? "echo $env:LUMISCA_TEST_ENV"
    : "echo $LUMISCA_TEST_ENV";
  const { commandId } = await manager.start({
    cwd: Deno.cwd(),
    command: echo,
    env: { LUMISCA_TEST_ENV: "command-level" },
  });
  const done = await exitPromise;
  assertEquals(done.commandId, commandId);
  assertEquals(done.reason, "exited");
  assert(done.tail.includes("command-level"), `tail: ${done.tail}`);
  assert(!done.tail.includes("manager-level"), `tail: ${done.tail}`);
});

Deno.test("async_bash start tool forwards env vars", async () => {
  const manager = new BackgroundProcessManager();
  const exitPromise = waitForExit(manager);
  const root = Deno.makeTempDirSync({ prefix: "lumisca-async-env-" });
  const sandbox = new Sandbox([root]);
  try {
    const [start] = createAsyncBashTools({ manager, sandbox });
    if (start === undefined) throw new Error("start tool missing");
    const echo = Deno.build.os === "windows"
      ? "echo $env:LUMISCA_TEST_ENV"
      : "echo $LUMISCA_TEST_ENV";
    const result = await start.execute(
      "1",
      {
        cwd: basename(root),
        command: echo,
        env: { LUMISCA_TEST_ENV: "hello-env" },
      },
      undefined,
    );
    assert(
      toolText(result).includes("Started background command #1"),
      `start result: ${toolText(result)}`,
    );
    const done = await exitPromise;
    assertEquals(done.reason, "exited");
    assert(done.tail.includes("hello-env"), `tail: ${done.tail}`);
  } finally {
    manager.killAll();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("kill stops the process tree and is idempotent", async () => {
  const manager = new BackgroundProcessManager();
  const exitPromise = waitForExit(manager);
  const { commandId } = await manager.start({
    cwd: Deno.cwd(),
    command: longCommand,
  });
  // Let the shell spawn before tearing it down (taskkill needs a live pid).
  await new Promise((resolve) => setTimeout(resolve, 500));
  const killed = await manager.kill(commandId);
  assertEquals(killed.alreadyExited, false);
  assertEquals(killed.timedOut, false);
  const done = await exitPromise;
  assertEquals(done.reason, "killed");
  assertEquals(manager.get(commandId)!.state, "killed");
  assertEquals((await manager.kill(commandId)).alreadyExited, true);
});

Deno.test("timeout kills the command and notifies with reason timeout", async () => {
  const manager = new BackgroundProcessManager();
  const exitPromise = waitForExit(manager);
  const { commandId } = await manager.start({
    cwd: Deno.cwd(),
    command: longCommand,
    timeoutSec: 1,
  });
  const done = await exitPromise;
  assertEquals(done.commandId, commandId);
  assertEquals(done.reason, "timeout");
  assertEquals(manager.get(commandId)!.state, "killed");
});

Deno.test("killAll stops every running command", async () => {
  const manager = new BackgroundProcessManager();
  const exitPromises: Promise<BackgroundCommandDone>[] = [];
  for (let i = 0; i < 3; i++) {
    exitPromises.push(waitForExit(manager));
    await manager.start({ cwd: Deno.cwd(), command: longCommand });
  }
  manager.killAll();
  for (const promise of exitPromises) {
    assertEquals((await promise).reason, "killed");
  }
});

Deno.test("the per-session concurrency limit is enforced", async () => {
  const manager = new BackgroundProcessManager();
  try {
    for (let i = 0; i < MAX_BACKGROUND_COMMANDS; i++) {
      await manager.start({ cwd: Deno.cwd(), command: longCommand });
    }
    let message = "";
    try {
      await manager.start({ cwd: Deno.cwd(), command: longCommand });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert(message.includes("Too many background commands"), message);
  } finally {
    manager.killAll();
  }
});

Deno.test("finished commands free their slot for new starts", async () => {
  const manager = new BackgroundProcessManager();
  try {
    // Fill every slot with short commands and let them all finish: the
    // slot limit is a concurrency limit, so a finished command must not
    // keep blocking new starts (regression: records were never released).
    for (let i = 0; i < MAX_BACKGROUND_COMMANDS; i++) {
      await manager.start({ cwd: Deno.cwd(), command: "echo hi" });
    }
    while (
      manager.list().some((info) => info.state === "running")
    ) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await manager.start({ cwd: Deno.cwd(), command: "echo ninth" });
    assertEquals(manager.list().length, MAX_BACKGROUND_COMMANDS + 1);
    // The finished commands stay queryable via get/tail.
    const first = manager.get("1");
    assertEquals(first?.state, "finished");
  } finally {
    manager.killAll();
  }
});

Deno.test("output tail is capped and keeps the last bytes", async () => {
  const manager = new BackgroundProcessManager();
  const exitPromise = waitForExit(manager);
  const spam = Deno.build.os === "windows"
    ? "for ($i = 0; $i -lt 4000; $i++) { echo 12345678901234567890 }"
    : "for i in $(seq 1 4000); do echo 12345678901234567890; done";
  await manager.start({ cwd: Deno.cwd(), command: spam });
  const done = await exitPromise;
  assertEquals(done.reason, "exited");
  assert(
    done.tail.length <= BACKGROUND_TAIL_LIMIT,
    `tail exceeds ${BACKGROUND_TAIL_LIMIT} bytes: ${done.tail.length}`,
  );
  assert(
    done.tail.trimEnd().endsWith("12345678901234567890"),
    `tail does not end with the last line: ${done.tail.slice(-80)}`,
  );
});

// --- tools -----------------------------------------------------------------

function makeTools() {
  const root = Deno.makeTempDirSync({ prefix: "lumisca-async-" });
  const sandbox = new Sandbox([root]);
  const manager = new BackgroundProcessManager();
  const tools = createAsyncBashTools({ manager, sandbox });
  return {
    root,
    manager,
    startTool: tools[0]!,
    statusTool: tools[1]!,
    killTool: tools[2]!,
  };
}

Deno.test("async_bash tool resolves cwd, reports status and kill", async () => {
  const { root, manager, startTool, statusTool, killTool } = makeTools();
  try {
    const exitPromise = waitForExit(manager);
    const result = await startTool.execute(
      "1",
      { cwd: root, command: linesCommand },
      undefined,
    );
    const text = toolText(result);
    assert(text.includes("Started background command #1"), text);
    const done = await exitPromise;
    assertEquals(done.reason, "exited");

    const status = await statusTool.execute("2", { id: "1" }, undefined);
    const statusText = toolText(status);
    assert(statusText.includes("finished"), statusText);
    assert(statusText.includes("exit code 0"), statusText);
    assert(statusText.includes("line2"), statusText);

    const list = await statusTool.execute("3", {}, undefined);
    assert(toolText(list).includes("#1"), toolText(list));

    const kill = await killTool.execute("4", { id: "1" }, undefined);
    assertEquals(kill.details?.alreadyExited, true);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("async_bash tools reject unknown ids", async () => {
  const { root, statusTool, killTool } = makeTools();
  try {
    let statusMessage = "";
    try {
      await statusTool.execute("1", { id: "nope" }, undefined);
    } catch (error) {
      statusMessage = error instanceof Error ? error.message : String(error);
    }
    assert(statusMessage.includes("Unknown background command"), statusMessage);

    let killMessage = "";
    try {
      await killTool.execute("2", { id: "nope" }, undefined);
    } catch (error) {
      killMessage = error instanceof Error ? error.message : String(error);
    }
    assert(killMessage.includes("Unknown background command"), killMessage);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("async_bash tool rejects an unknown cwd", async () => {
  const { root, startTool } = makeTools();
  try {
    let message = "";
    try {
      await startTool.execute(
        "1",
        { cwd: "nope", command: "echo x" },
        undefined,
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert(message.includes("Unknown workspace folder"), message);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// --- notification format ----------------------------------------------------

Deno.test("formatBackgroundNotification covers every reason", () => {
  const exited = formatBackgroundNotification({
    commandId: "3",
    exitCode: 0,
    reason: "exited",
    durationSec: 125,
    tail: "listening on :3000",
  });
  assertEquals(exited, {
    kind: "background",
    title: "[Background command #3 finished after 2m 05s (exit code 0)]",
    body: "listening on :3000",
    status: "success",
  });

  const failed = formatBackgroundNotification({
    commandId: "4",
    exitCode: 1,
    reason: "exited",
    durationSec: 10,
    tail: "",
  });
  assertEquals(failed, {
    kind: "background",
    title: "[Background command #4 finished after 10s (exit code 1)]",
    body: "",
    status: "error",
  });

  const timeout = formatBackgroundNotification({
    commandId: "1",
    reason: "timeout",
    durationSec: 60,
    tail: "",
  });
  assertEquals(timeout, {
    kind: "background",
    title: "[Background command #1 was killed after 1m 00s (timeout)]",
    body: "",
    status: "error",
  });

  const killed = formatBackgroundNotification({
    commandId: "2",
    reason: "killed",
    durationSec: 5,
    tail: "  ",
  });
  assertEquals(killed, {
    kind: "background",
    title: "[Background command #2 was killed]",
    body: "",
    status: "error",
  });
});

Deno.test("trimIncompleteUtf8 drops incomplete trailing sequences", () => {
  const full = new TextEncoder().encode("a\u3042"); // "a" + あ (3 bytes)
  assertEquals(trimIncompleteUtf8(full).length, full.length);
  // "a" + the first two bytes of あ: the incomplete sequence must go.
  const cut = full.slice(0, 3);
  assertEquals(new TextDecoder().decode(trimIncompleteUtf8(cut)), "a");
  const ascii = new TextEncoder().encode("abc");
  assertEquals(trimIncompleteUtf8(ascii).length, 3);
  assertEquals(trimIncompleteUtf8(new Uint8Array(0)).length, 0);
});

// --- end to end: completion notification reaches the agent ----------------

/** Concatenate the text blocks of a message (works on the agent's message
 * union, which mixes content-carrying and non-content variants). */
function messageText(message: unknown): string {
  const m = message as {
    role?: string;
    title?: string;
    body?: string;
    content?: unknown;
  };
  if (m.role === "notification") {
    return (m.body?.length ?? 0) > 0
      ? `${m.title}\n${m.body}`
      : (m.title ?? "");
  }
  const content = m.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((b) => (b as { type?: string }).type === "text")
    .map((b) => (b as { text?: string }).text ?? "").join("");
}

/** Poll the transcript until some message text matches (bounded so a hang
 * fails the test instead of running forever). */
async function waitForMessage(
  agent: { messages: unknown[] },
  predicate: (text: string) => boolean,
  timeoutMs = 15000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (agent.messages.some((m) => predicate(messageText(m)))) return;
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for message; transcript: ${
          JSON.stringify(agent.messages.map(messageText))
        }`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

Deno.test("background completion is injected into the agent loop", async () => {
  const faux = fauxProvider();
  const core = LumiscaCore.forTesting([faux.provider]);
  const root = await Deno.makeTempDir({ prefix: "lumisca-async-e2e-" });
  try {
    const ws = await core.createWorkspace("ws", [root]);
    const session = core.createSession({
      workspaceId: ws.id,
      modelProvider: faux.provider.id,
      modelId: faux.getModel().id,
    });

    // Turn 1: the agent starts a background command; turn 2: it confirms;
    // turn 3 (triggered by the completion notification, after the command
    // exits): it reports the result. The faux queue holds all three.
    faux.setResponses([
      fauxAssistantMessage([
        fauxText("Starting the server."),
        fauxToolCall("async_bash", { cwd: root, command: briefCommand }),
      ]),
      fauxAssistantMessage("Server started."),
      fauxAssistantMessage("The background command finished."),
    ]);
    await core.prompt(session.id, "Start a background server");

    const agent = core.getAgent(session.id)!;
    await waitForMessage(
      agent,
      (text) => text.startsWith("[Background command #1"),
    );
    await waitForMessage(
      agent,
      (text) => text === "The background command finished.",
    );
  } finally {
    core.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("background commands survive a session rebuild", async () => {
  const faux = fauxProvider();
  const core = LumiscaCore.forTesting([faux.provider]);
  const root = await Deno.makeTempDir({ prefix: "lumisca-async-rebuild-" });
  try {
    const ws = await core.createWorkspace("ws", [root]);
    const session = core.createSession({
      workspaceId: ws.id,
      modelProvider: faux.provider.id,
      modelId: faux.getModel().id,
    });

    // Turn 1: the agent starts a long-running background command.
    faux.setResponses([
      fauxAssistantMessage([
        fauxText("Starting the long command."),
        fauxToolCall("async_bash", { cwd: root, command: longCommand }),
      ]),
      fauxAssistantMessage("Started."),
    ]);
    await core.prompt(session.id, "Start a long command");
    const agent = core.getAgent(session.id)!;
    await waitForMessage(
      agent,
      (text) => text.includes("Started background command #1"),
    );

    // Rebuild the session (a model change rebuilds the agent while the
    // session stays open).
    core.setSessionModel(session.id, faux.provider.id, faux.getModel().id);
    const rebuilt = core.getAgent(session.id)!;
    assert(rebuilt !== agent, "setSessionModel did not rebuild the agent");

    // The command must still be running: ask the rebuilt agent to list it.
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("async_bash_status", {})]),
      fauxAssistantMessage("Status checked."),
    ]);
    await core.prompt(session.id, "Check background commands");
    await waitForMessage(
      rebuilt,
      (text) => text.includes("#1") && text.includes("running"),
    );

    // Kill it through the rebuilt agent. A command killed with
    // async_bash_kill must NOT produce a completion notification (the tool
    // result is the confirmation); the final state is visible via
    // async_bash_status.
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("async_bash_kill", { id: "1" })]),
      fauxAssistantMessage("Killed."),
    ]);
    await core.prompt(session.id, "Stop the command");
    await waitForMessage(rebuilt, (text) => text === "Killed.");

    // Poll the status until the command shows killed (finalize runs a beat
    // after the kill resolves; a single check could race it).
    let killed = false;
    for (let i = 0; i < 20 && !killed; i++) {
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall("async_bash_status", { id: "1" })]),
        fauxAssistantMessage("Checked."),
      ]);
      await core.prompt(session.id, "Check the command again");
      killed = rebuilt.messages.some((m) =>
        messageText(m).includes("Background command #1: killed")
      );
      if (!killed) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert(
      killed,
      `the command never reached the killed state: ${
        JSON.stringify(rebuilt.messages.map(messageText))
      }`,
    );

    // Once the status reports killed, finalize has run, so any notification
    // would already be in the transcript. Assert none was injected.
    const transcript = rebuilt.messages.map(messageText);
    assert(
      !transcript.some((t) => t.startsWith("[Background command")),
      `a kill notification was injected: ${JSON.stringify(transcript)}`,
    );
  } finally {
    core.close();
    await removeTreeRetry(root);
  }
});
