import { contentText, type ClientEvent, type LumiscaCore, type SessionInfo } from "@lumisca/core";
import { color, error, getPromptFn, header, info, success, userLine } from "./ui.ts";
import { pickModel, pickWorkspace, selectFromList } from "./select.ts";

function summarize(text: string, max = 300): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max)}…`;
}

function printToolStart(toolName: string, args: unknown): void {
  const argsText = summarize(JSON.stringify(args ?? {}), 120);
  console.log(color.cyan(`  ⚙ ${toolName} ${color.faint(argsText)}`));
}

function printToolEnd(toolName: string, result: unknown, isError: boolean): void {
  const r = result as { content?: Array<{ type: string; text?: string }> } | null;
  const text = r?.content ? contentText(r.content as Array<{ type: string; text?: string }>) : "";
  const summary = summarize(text, 200);
  if (isError) {
    console.log(color.red(`  ✗ ${toolName} → ${summary}`));
  } else {
    console.log(color.dim(`  ✓ ${toolName} → ${summary}`));
  }
}

/** Interactive single-session REPL. */
export async function runRepl(core: LumiscaCore, sessionId: string): Promise<void> {
  let currentId = sessionId;
  let agent = core.getAgent(currentId);
  if (!agent) {
    await core.openSession(currentId);
    agent = core.getAgent(currentId)!;
  }

  let streaming = false;

  const unsubscribe = core.subscribe((event: ClientEvent) => {
    if (event.type === "session_created") return;
    if (event.sessionId !== currentId) return;
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

  header(`Lumisca CLI — ${sessionName(core, currentId)}`);
  info("/help でコマンド一覧");

  for (;;) {
    if (streaming) {
      await agent.waitForIdle();
      streaming = false;
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
        unsubscribe(); // re-subscribe with the new session scope
        continue;
      }
      continue;
    }

    userLine(trimmed);
    try {
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

async function handleCommand(
  core: LumiscaCore,
  raw: string,
  currentId: string,
): Promise<CommandResult> {
  const [cmd, ...rest] = raw.slice(1).split(/\s+/);
  const arg = rest.join(" ").trim();

  switch (cmd) {
    case "help": {
      header("コマンド");
      for (const [k, v] of [
        ["/new", "新しいセッションを作成"],
        ["/resume", "過去のセッションから再開"],
        ["/model", "モデルを変更"],
        ["/workspace", "ワークスペースを切り替え"],
        ["/keys", "APIキーを設定"],
        ["/sessions", "セッション一覧"],
        ["/name", "セッション名を変更"],
        ["/exit", "終了"],
      ] as const) {
        console.log(`  ${color.yellow(k.padEnd(12))} ${v}`);
      }
      return undefined;
    }

    case "new": {
      const model = await pickModel(core);
      if (!model) return undefined;
      const workspaceId = core.getSession(currentId)?.workspaceId;
      if (!workspaceId) return undefined;
      const session = core.createSession({
        workspaceId,
        modelProvider: model.providerId,
        modelId: model.modelId,
      });
      success(`セッション作成: ${session.id} (${model.providerId}/${model.modelId})`);
      return session.id;
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
          label: `${s.name} ${color.faint(`${s.modelProvider}/${s.modelId} (${formatDate(s.updatedAt)})`)}`,
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

    case "workspace": {
      const id = await pickWorkspace(core);
      if (id === null) return undefined;
      // create a fresh session in the new workspace
      const model = await pickModel(core);
      if (!model) return undefined;
      const session = core.createSession({
        workspaceId: id,
        modelProvider: model.providerId,
        modelId: model.modelId,
      });
      success(`ワークスペース切替 → 新セッション: ${session.id}`);
      return session.id;
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
        console.log(`  ${active} ${s.name} ${color.faint(`${s.modelProvider}/${s.modelId}`)}`);
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

function formatDate(ts: number): string {
  return new Date(ts).toLocaleString();
}
