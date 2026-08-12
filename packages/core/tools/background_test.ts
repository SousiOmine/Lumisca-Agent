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
  formatCompletionNotification,
  MAX_BACKGROUND_COMMANDS,
  trimIncompleteUtf8,
} from "./background.ts";
import { Sandbox } from "../workspace/sandbox.ts";
import { LumiscaCore } from "../mod.ts";

/** Cross-platform commands. cmd.exe has no sleep; ping is the classic
 * stand-in. */
const longCommand = Deno.build.os === "windows"
  ? "ping -n 60 127.0.0.1 >nul"
  : "sleep 60";
const briefCommand = Deno.build.os === "windows"
  ? "ping -n 2 127.0.0.1 >nul & echo done"
  : "sleep 1; echo done";
const linesCommand = Deno.build.os === "windows"
  ? "echo start & echo line1 & echo line2"
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
  const started = Date.now();
  const { commandId } = await manager.start({
    cwd: Deno.cwd(),
    command: briefCommand,
  });
  // start() must resolve while the command is still running.
  assert(Date.now() - started < 1000, "start() did not return immediately");
  assert(manager.get(commandId)!.state === "running");
  const done = await exitPromise;
  assertEquals(done.commandId, commandId);
  assertEquals(done.reason, "exited");
  assertEquals(done.exitCode, 0);
  assert(done.tail.includes("done"), `tail missing output: ${done.tail}`);
  assertEquals(manager.get(commandId)!.state, "finished");
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
    ? "echo %LUMISCA_TEST_ENV%"
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
      ? "echo %LUMISCA_TEST_ENV%"
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

Deno.test("output tail is capped and keeps the last bytes", async () => {
  const manager = new BackgroundProcessManager();
  const exitPromise = waitForExit(manager);
  const spam = Deno.build.os === "windows"
    ? "for /L %i in (1,1,4000) do echo 12345678901234567890"
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

Deno.test("formatCompletionNotification covers every reason", () => {
  const exited = formatCompletionNotification({
    commandId: "3",
    exitCode: 0,
    reason: "exited",
    durationSec: 125,
    tail: "listening on :3000",
  });
  assertEquals(
    exited,
    "[Background command #3 finished after 2m 05s (exit code 0)]\nlistening on :3000",
  );

  const timeout = formatCompletionNotification({
    commandId: "1",
    reason: "timeout",
    durationSec: 60,
    tail: "",
  });
  assertEquals(
    timeout,
    "[Background command #1 was killed after 1m 00s (timeout)]",
  );

  const killed = formatCompletionNotification({
    commandId: "2",
    reason: "killed",
    durationSec: 5,
    tail: "  ",
  });
  assertEquals(killed, "[Background command #2 was killed]");
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
  const content = (message as { content?: unknown }).content;
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
    await Deno.remove(root, { recursive: true });
  }
});
