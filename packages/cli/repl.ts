import {
  type ClientEvent,
  contentText,
  getSupportedThinkingLevels,
  type LumiscaCore,
  THINKING_LEVEL_LABELS,
} from "@lumisca/core";
import {
  color,
  error,
  getPromptFn,
  header,
  info,
  success,
  userLine,
} from "./ui.ts";
import {
  pickModel,
  pickWorkspace,
  selectFromList,
  sessionLabel,
} from "./select.ts";
import { createSession } from "./session.ts";

function summarize(text: string, max = 300): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max)}…`;
}

function printToolStart(toolName: string, args: unknown): void {
  const argsText = summarize(JSON.stringify(args ?? {}), 120);
  console.log(color.cyan(`  ⚙ ${toolName} ${color.faint(argsText)}`));
}

function printTaskStart(
  agentId: string,
  subagentType: string,
  description: string,
): void {
  console.log(
    color.blue(
      `  ◉ task ${agentId} (${subagentType}) ${color.faint(description)}`,
    ),
  );
}

function printTaskEnd(agentId: string, status: string): void {
  const mark = status === "finished" ? color.green("✓") : color.red("✗");
  console.log(color.blue(`  ${mark} task ${agentId} ${status}`));
}

function printToolEnd(
  toolName: string,
  result: unknown,
  isError: boolean,
): void {
  const r = result as
    | { content?: Array<{ type: string; text?: string }> }
    | null;
  const text = r?.content
    ? contentText(r.content as Array<{ type: string; text?: string }>)
    : "";
  const summary = summarize(text, 200);
  if (isError) {
    console.log(color.red(`  ✗ ${toolName} → ${summary}`));
  } else {
    console.log(color.dim(`  ✓ ${toolName} → ${summary}`));
  }
}

/** Interactive single-session REPL. */
export async function runRepl(
  core: LumiscaCore,
  sessionId: string,
): Promise<void> {
  let currentId = sessionId;
  let agent = core.getAgent(currentId);
  if (!agent) {
    await core.openSession(currentId);
    agent = core.getAgent(currentId)!;
  }

  let streaming = false;

  /** Subscribe to the events of one session. Returns an unsubscribe
   * function; call it before switching to another session scope. */
  const subscribeTo = (targetId: string): () => void => {
    return core.subscribe((event: ClientEvent) => {
      if (event.type === "session_created") return;
      if (event.sessionId !== targetId) return;
      switch (event.type) {
        case "message_delta":
          process.stdout.write(event.delta);
          streaming = true;
          break;
        case "message_end":
          if (event.message.role === "assistant" && streaming) {
            process.stdout.write("\n");
          }
          streaming = false;
          break;
        case "tool_start":
          printToolStart(event.toolName, event.args);
          break;
        case "tool_end":
          printToolEnd(event.toolName, event.result, event.isError);
          break;
        case "task_start":
          printTaskStart(
            event.agentId,
            event.subagentType,
            event.description,
          );
          break;
        case "task_end":
          printTaskEnd(event.agentId, event.status);
          break;
        case "session_error":
          if (streaming) process.stdout.write("\n");
          streaming = false;
          error(`エラー: ${event.message}`);
          break;
        case "agent_end":
          streaming = false;
          break;
        default:
          break;
      }
    });
  };

  let unsubscribe = subscribeTo(currentId);

  header(`Lumisca CLI — ${sessionName(core, currentId)}`);
  info("/help でコマンド一覧");

  for (;;) {
    // Wait for the current run before reading input. isStreaming is
    // authoritative (the renderer's streaming flag misses tool-only runs).
    if (agent.isStreaming) {
      await agent.waitForIdle();
    }

    const input = await getPromptFn()("❯");
    if (input === null) {
      break;
    }
    const trimmed = input.trim();
    if (trimmed === "") continue;

    if (trimmed.startsWith("/")) {
      const next = await handleCommand(core, trimmed, currentId);
      if (next === "exit") break;
      if (next && next !== currentId) {
        currentId = next;
        agent = core.getAgent(currentId)!;
        unsubscribe(); // drop the old subscription...
        unsubscribe = subscribeTo(currentId); // ...and re-subscribe to the new session
        header(`Lumisca CLI — ${sessionName(core, currentId)}`);
      }
      continue;
    }

    userLine(trimmed);
    try {
      // Run failures arrive as session_error events, but prompt() can still
      // throw synchronously (session not open / already running) — surface
      // those instead of crashing the REPL with an unhandled rejection.
      await core.prompt(currentId, trimmed);
    } catch (e) {
      error(e instanceof Error ? e.message : String(e));
    }
  }

  unsubscribe();
}

function sessionName(core: LumiscaCore, id: string): string {
  return core.getSession(id)?.name ?? id;
}

type CommandResult = "exit" | string | undefined;

export async function handleCommand(
  core: LumiscaCore,
  raw: string,
  currentId: string,
): Promise<CommandResult> {
  const [cmd, ...rest] = raw.slice(1).split(/\s+/);
  const arg = rest.join(" ").trim();

  switch (cmd) {
    case "help": {
      header("コマンド");
      for (
        const [k, v] of [
          ["/new", "新しいセッションを作成"],
          ["/resume", "過去のセッションから再開"],
          ["/model", "モデルを変更"],
          ["/thinking", "思考強度を変更"],
          ["/workspace", "ワークスペースを切り替え"],
          ["/keys", "APIキーを設定"],
          ["/sessions", "セッション一覧"],
          ["/name", "セッション名を変更"],
          ["/exit", "終了"],
        ] as const
      ) {
        console.log(`  ${color.yellow(k.padEnd(12))} ${v}`);
      }
      return undefined;
    }

    case "new": {
      const workspaceId = core.getSession(currentId)?.workspaceId;
      if (!workspaceId) return undefined;
      return (await createSession(core, workspaceId)) ?? undefined;
    }

    case "resume": {
      const sessions = core.listSessions();
      if (sessions.length === 0) {
        info("セッションはありません");
        return undefined;
      }
      const id = await selectFromList(
        "セッションを選択",
        sessions.map((s) => ({
          label: sessionLabel(s, { date: true }),
          value: s.id,
        })),
      );
      if (id === null) return undefined;
      await core.openSession(id);
      return id;
    }

    case "model": {
      const model = await pickModel(core);
      if (!model) return undefined;
      core.setSessionModel(currentId, model.providerId, model.modelId);
      success(`モデル変更: ${model.providerId}/${model.modelId}`);
      return undefined;
    }

    case "thinking": {
      const session = core.getSession(currentId);
      if (!session) return undefined;
      const levels = getSupportedThinkingLevels(
        core.getModel(session.modelProvider, session.modelId),
      );
      if (levels.length <= 1) {
        info("このモデルは思考モードに対応していません");
        return undefined;
      }
      const current = session.thinkingLevel ?? "off";
      const level = await selectFromList(
        "思考強度を選択",
        levels.map((l) => ({
          label: `${THINKING_LEVEL_LABELS[l]}${l === current ? " (現在)" : ""}`,
          value: l,
        })),
      );
      if (level === null) return undefined;
      const effective = core.setModelThinkingLevel(
        session.modelProvider,
        session.modelId,
        level,
      );
      success(`思考強度変更: ${THINKING_LEVEL_LABELS[effective]}`);
      return undefined;
    }

    case "workspace": {
      const id = await pickWorkspace(core);
      if (id === null) return undefined;
      // create a fresh session in the new workspace
      return (await createSession(core, id)) ?? undefined;
    }

    case "keys": {
      const providerId = await getPromptFn()("プロバイダーID (例: anthropic):");
      if (!providerId || providerId.trim() === "") return undefined;
      const key = await getPromptFn()("APIキー:");
      if (!key || key.trim() === "") return undefined;
      await core.setProviderApiKey(providerId.trim(), key.trim());
      success("APIキーを保存しました");
      return undefined;
    }

    case "sessions": {
      const sessions = core.listSessions();
      header("セッション一覧");
      for (const s of sessions.slice(0, 30)) {
        const active = s.id === currentId ? color.green("*") : " ";
        console.log(`  ${active} ${sessionLabel(s)}`);
      }
      return undefined;
    }

    case "name": {
      if (!arg) {
        error("/name <セッション名>");
        return undefined;
      }
      // Rename is persisted via a session update.
      core.setSessionName(currentId, arg);
      success(`セッション名: ${arg}`);
      return undefined;
    }

    case "exit":
    case "quit":
    case "q":
      return "exit";

    default:
      error(`不明なコマンド: /${cmd} (/help を参照)`);
      return undefined;
  }
}
