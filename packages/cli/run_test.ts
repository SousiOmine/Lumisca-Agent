import { join } from "node:path";
import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { LumiscaCore } from "@lumisca/core";
import {
  finalAnswerText,
  HelpRequested,
  parseRunArgs,
  printRunResult,
  RUN_USAGE,
  runOnce,
  type RunResult,
} from "./run.ts";

Deno.test("parseRunArgs parses every flag", () => {
  const opts = parseRunArgs([
    "--workspace",
    "C:/work",
    "--prompt",
    "fix the bug",
    "--model",
    "custom/deepseek-chat",
    "--json",
    "--db",
    "C:/db/lumisca.db",
  ]);
  assertEquals(opts.workspacePath, "C:/work");
  assertEquals(opts.prompt, "fix the bug");
  assertEquals(opts.model, "custom/deepseek-chat");
  assertEquals(opts.json, true);
  assertEquals(opts.dbPath, "C:/db/lumisca.db");
});

Deno.test("parseRunArgs defaults workspace to cwd and db to LUMISCA_DB", () => {
  const saved = Deno.env.get("LUMISCA_DB");
  Deno.env.delete("LUMISCA_DB");
  try {
    const opts = parseRunArgs(["--prompt", "hi"]);
    assertEquals(opts.workspacePath, Deno.cwd());
    assertEquals(opts.dbPath, `${Deno.cwd()}/lumisca.db`);
    assertEquals(opts.json, false);
  } finally {
    if (saved !== undefined) Deno.env.set("LUMISCA_DB", saved);
  }
});

Deno.test("parseRunArgs rejects a missing prompt", () => {
  assertThrows(() => parseRunArgs(["--prompt", ""]), Error, "プロンプトが必要");
  // 引数なし (stdin が TTY でないテスト環境では空) も拒否される。
  assertThrows(() => parseRunArgs([]), Error, "プロンプトが必要");
});

Deno.test("parseRunArgs rejects --model without a provider", () => {
  assertThrows(
    () => parseRunArgs(["--prompt", "hi", "--model", "deepseek-chat"]),
    Error,
    "プロバイダ/モデルID",
  );
});

Deno.test("parseRunArgs rejects unknown flags", () => {
  assertThrows(() => parseRunArgs(["--prompt", "hi", "--bogus"]), Error);
});

Deno.test("parseRunArgs accepts a --prefixed prompt value", () => {
  const opts = parseRunArgs(["--prompt", "--foo"]);
  assertEquals(opts.prompt, "--foo");
});

Deno.test("parseRunArgs treats a following known flag as a missing value", () => {
  assertThrows(
    () => parseRunArgs(["--prompt", "--json"]),
    Error,
    "値が必要",
  );
});

Deno.test("parseRunArgs skips a -- separator (deno task)", () => {
  const opts = parseRunArgs(["--", "--prompt", "hi"]);
  assertEquals(opts.prompt, "hi");
});

Deno.test("parseRunArgs --help throws HelpRequested", () => {
  assertThrows(() => parseRunArgs(["--help"]), HelpRequested);
  assertThrows(() => parseRunArgs(["-h"]), HelpRequested);
});

Deno.test("finalAnswerText returns the last assistant text", () => {
  assertEquals(finalAnswerText([]), "");
  assertEquals(
    finalAnswerText([
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "answer" }] },
      { role: "user", content: [{ type: "text", text: "more" }] },
    ] as never),
    "answer",
  );
});

Deno.test("runOnce executes a headless run and returns the transcript", async () => {
  const faux = fauxProvider();
  const core = LumiscaCore.forTesting([faux.provider]);
  const dir = await Deno.makeTempDir({ prefix: "lumisca-run-" });
  try {
    faux.setResponses([fauxAssistantMessage("hello from run")]);
    const result = await runOnce(core, {
      dbPath: join(dir, "lumisca.db"),
      workspacePath: dir,
      prompt: "say hello",
      // 明示指定: テスト環境の認証状態 (実プロバイダの env キー) に
      // 依存せず faux で実行する。
      model: `${faux.provider.id}/${faux.getModel().id}`,
      json: false,
    });
    assertEquals(result.error, undefined);
    assertEquals(result.messages.length, 2);
    assertEquals(result.messages[0]!.role, "user");
    assertEquals(result.messages[1]!.role, "assistant");
    assertEquals(finalAnswerText(result.messages), "hello from run");
    // The session is persisted (regular DB behavior).
    assertEquals(core.getSession(result.sessionId) !== undefined, true);
    // The session is headless (ask auto-answers — verified in core tests).
    assertEquals(core.getAgent(result.sessionId)!.isStreaming, false);
  } finally {
    core.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runOnce surfaces session errors on the result", async () => {
  const faux = fauxProvider();
  const core = LumiscaCore.forTesting([faux.provider]);
  const dir = await Deno.makeTempDir({ prefix: "lumisca-run-" });
  try {
    // A model-stream failure ends the run with an error assistant message
    // (stopReason "error"); the run must surface it as the result error.
    faux.setResponses([
      fauxAssistantMessage("", { errorMessage: "boom", stopReason: "error" }),
    ]);
    const result = await runOnce(core, {
      dbPath: join(dir, "lumisca.db"),
      workspacePath: dir,
      prompt: "go",
      model: `${faux.provider.id}/${faux.getModel().id}`,
      json: false,
    });
    assertEquals(result.error, "boom");
  } finally {
    core.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runOnce reuses a workspace with the same folder", async () => {
  const faux = fauxProvider();
  const core = LumiscaCore.forTesting([faux.provider]);
  const dir = await Deno.makeTempDir({ prefix: "lumisca-run-" });
  try {
    faux.setResponses([fauxAssistantMessage("one")]);
    const first = await runOnce(core, {
      dbPath: join(dir, "lumisca.db"),
      workspacePath: dir,
      prompt: "one",
      json: false,
    });
    faux.setResponses([fauxAssistantMessage("two")]);
    const second = await runOnce(core, {
      dbPath: join(dir, "lumisca.db"),
      workspacePath: dir,
      prompt: "two",
      json: false,
    });

    const workspaces = core.listWorkspaces();
    assertEquals(workspaces.length, 1, "the same folder reuses the workspace");
    assertEquals(first.sessionId !== second.sessionId, true);
    assertEquals(
      core.getSession(first.sessionId)!.workspaceId,
      core.getSession(second.sessionId)!.workspaceId,
    );
  } finally {
    core.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runOnce rejects a missing workspace folder", async () => {
  const faux = fauxProvider();
  const core = LumiscaCore.forTesting([faux.provider]);
  try {
    await assertRejects(
      () =>
        runOnce(core, {
          dbPath: "test.db",
          workspacePath: "C:/definitely/missing/folder",
          prompt: "hi",
          json: false,
        }),
      Error,
    );
  } finally {
    core.close();
  }
});

Deno.test("runOnce skips a disabled last-used model (default path)", async () => {
  const faux = fauxProvider({
    models: [
      { id: "main", input: ["text"] },
      { id: "alt", input: ["text"] },
    ],
  });
  const core = LumiscaCore.forTesting([faux.provider]);
  const dir = await Deno.makeTempDir({ prefix: "lumisca-run-" });
  try {
    // Make "main" the last-used model (the default-model source)...
    const ws = await core.createWorkspace("ws", [dir]);
    core.createSession({
      workspaceId: ws.id,
      modelProvider: faux.provider.id,
      modelId: "main",
    });
    // ...then disable it: the default path must not use it (it falls back
    // to the first enabled model of an authenticated provider).
    core.setModelEnabled(faux.provider.id, "main", false);

    faux.setResponses([fauxAssistantMessage("hello")]);
    const result = await runOnce(core, {
      dbPath: join(dir, "lumisca.db"),
      workspacePath: dir,
      prompt: "hi",
      json: false,
    });
    assertEquals(result.modelId !== "main", true);
    assertEquals(
      core.isModelEnabled(result.provider, result.modelId),
      true,
      "the fallback model must be an enabled one",
    );
  } finally {
    core.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("printRunResult prints the final answer as text by default", () => {
  const result: RunResult = {
    sessionId: "s1",
    provider: "p",
    modelId: "m",
    messages: [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "final text" }] },
    ] as never,
  };
  const logs: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => logs.push(args.join(" "));
  try {
    printRunResult(result, false);
  } finally {
    console.log = original;
  }
  assertEquals(logs, ["final text"]);
});

Deno.test("printRunResult prints the full transcript as JSON with --json", () => {
  const result: RunResult = {
    sessionId: "s1",
    provider: "p",
    modelId: "m",
    messages: [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "answer" }] },
    ] as never,
  };
  const logs: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => logs.push(args.join(" "));
  try {
    printRunResult(result, true);
  } finally {
    console.log = original;
  }
  assertEquals(logs.length, 1);
  const parsed = JSON.parse(logs[0]!) as RunResult;
  assertEquals(parsed.sessionId, "s1");
  assertEquals(parsed.messages.length, 2);
  assertEquals(parsed.messages[1]!.role, "assistant");
});

Deno.test("RUN_USAGE documents the run command", () => {
  assertStringIncludes(RUN_USAGE, "lumisca run");
  assertStringIncludes(RUN_USAGE, "--prompt");
  assertStringIncludes(RUN_USAGE, "--json");
});
