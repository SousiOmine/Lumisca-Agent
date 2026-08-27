import {
  autoAnswerSelect,
  type ClientEvent,
  getSupportedThinkingLevels,
  type LumiscaCore,
  THINKING_LEVEL_LABELS,
} from "@lumisca/core";
import type { AuthInteraction } from "@earendil-works/pi-ai";
import {
  color,
  error,
  errorText,
  getPromptFn,
  header,
  info,
  success,
  userLine,
} from "./ui.ts";
import {
  answerQuestions,
  printTaskEnd,
  printTaskStart,
  printToolEnd,
  printToolStart,
  StreamPrinter,
} from "./render.ts";
import {
  pickModel,
  pickWorkspace,
  selectFromList,
  sessionLabel,
} from "./select.ts";
import { createSession } from "./session.ts";

/** Subscribe to the events of one session and render them to the terminal.
 * Returns an unsubscribe function; call it before switching to another
 * session scope. The printer's streaming state survives switches (one
 * stream at a time per REPL). */
function subscribeToSession(
  core: LumiscaCore,
  targetId: string,
  printer: StreamPrinter,
): () => void {
  return core.subscribe((event: ClientEvent) => {
    if (event.type === "session_created") return;
    if (event.sessionId !== targetId) return;
    switch (event.type) {
      case "message_delta":
        printer.write(event.delta);
        break;
      case "message_end":
        printer.end(event.message.role);
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
        printer.end();
        error(`エラー: ${event.message}`);
        break;
      case "agent_end":
        printer.end();
        break;
      case "question":
        // The run is blocked waiting for answers; answer inline (the
        // REPL loop itself waits for the run to idle, so this is the
        // only place input can be read while the ask is pending).
        printer.end();
        void answerQuestions(
          core,
          targetId,
          event.toolCallId,
          event.questions,
        );
        break;
      case "session_renamed":
        info(`セッション名が変更されました: ${event.name}`);
        break;
      default:
        break;
    }
  });
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

  const printer = new StreamPrinter();
  let unsubscribe = subscribeToSession(core, currentId, printer);

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
        unsubscribe = subscribeToSession(core, currentId, printer); // ...and re-subscribe to the new session
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
      error(errorText(e));
    }
  }

  unsubscribe();
}

function sessionName(core: LumiscaCore, id: string): string {
  return core.getSession(id)?.name ?? id;
}

/** Drive a provider OAuth login from the terminal: print the device code
 * / auth URL the flow emits and answer its prompts. The Deno-compatible
 * device-code method is auto-selected when offered. */
async function runOAuthLogin(
  core: LumiscaCore,
  providerId: string,
): Promise<void> {
  const interaction: AuthInteraction = {
    prompt: async (prompt) => {
      if (prompt.type === "select") {
        const auto = autoAnswerSelect(prompt.options);
        if (auto !== undefined) return auto;
        const chosen = await selectFromList(
          prompt.message,
          prompt.options.map((o) => ({ label: o.label, value: o.id })),
        );
        if (chosen === null) throw new Error("ログインをキャンセルしました");
        return chosen;
      }
      const placeholder = prompt.placeholder ? ` (${prompt.placeholder})` : "";
      const value = await getPromptFn()(` ${prompt.message}${placeholder}:`);
      if (value === null) throw new Error("ログインをキャンセルしました");
      return value.trim();
    },
    notify: (event) => {
      if (event.type === "device_code") {
        header("デバイスコード");
        console.log(`  ${color.cyan(event.userCode)}`);
        info(`以下のURLを開いてコードを入力・承認してください:`);
        console.log(`  ${event.verificationUri}`);
      } else if (event.type === "auth_url") {
        info("以下のURLをブラウザで開いてログインしてください:");
        console.log(`  ${event.url}`);
        if (event.instructions) console.log(`  ${event.instructions}`);
      } else {
        info(event.message);
      }
    },
  };
  await core.loginProvider(providerId, "oauth", interaction);
  success("ログインしました");
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
          ["/addprovider", "OpenAI互換プロバイダを追加"],
          ["/delprovider", "追加したプロバイダを削除"],
          ["/login", "ChatGPT等をOAuthでログイン"],
          ["/logout", "OAuthログインを解除"],
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

    case "login": {
      let providerId = arg;
      if (!providerId) {
        const providers = core.listProviders().filter((p) =>
          core.getProviderAuthType(p.id) === "oauth"
        );
        if (providers.length === 0) {
          error("OAuth対応のプロバイダーが見つかりません");
          return undefined;
        }
        const chosen = await selectFromList(
          "OAuth対応プロバイダー",
          providers.map((p) => ({ label: p.name, value: p.id })),
        );
        if (chosen === null) return undefined;
        providerId = chosen;
      }
      if (core.getProviderAuthType(providerId) !== "oauth") {
        error(`${providerId} はOAuthログインに対応していません`);
        return undefined;
      }
      try {
        await runOAuthLogin(core, providerId.trim());
      } catch (e) {
        error(errorText(e));
      }
      return undefined;
    }

    case "logout": {
      if (!arg) {
        error("/logout <プロバイダーID>");
        return undefined;
      }
      await core.logoutProvider(arg.trim());
      success("ログアウトしました");
      return undefined;
    }

    case "addprovider": {
      const name = await getPromptFn()("表示名 (例: 自宅 vLLM):");
      if (!name || name.trim() === "") return undefined;
      const id = await getPromptFn()("プロバイダーID (英数字・. _ -):");
      if (!id || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id.trim())) {
        error("プロバイダーIDが不正です");
        return undefined;
      }
      const baseUrl = await getPromptFn()("Base URL (https://.../v1):");
      if (!baseUrl || baseUrl.trim() === "") return undefined;
      const apiRaw = await getPromptFn()(
        "API (openai-completions / openai-responses) [openai-completions]:",
      );
      const api = apiRaw && apiRaw.trim() !== ""
        ? apiRaw.trim()
        : "openai-completions";
      const modelIds = await getPromptFn()("モデルID (カンマ区切り):");
      if (!modelIds || modelIds.trim() === "") return undefined;
      const models = modelIds.split(",").map((s) => s.trim())
        .filter((s) => s.length > 0)
        .map((modelId) => ({ id: modelId }));
      if (models.length === 0) {
        error("モデルIDを1つ以上入力してください");
        return undefined;
      }
      const apiKey = await getPromptFn()("APIキー (空で省略):");
      try {
        const summary = await core.addUserProvider({
          id: id.trim(),
          name: name.trim(),
          baseUrl: baseUrl.trim(),
          api,
          models,
          ...(apiKey && apiKey.trim() !== "" ? { apiKey: apiKey.trim() } : {}),
        });
        success(`プロバイダーを追加しました: ${summary.id}`);
      } catch (e) {
        error(errorText(e));
      }
      return undefined;
    }

    case "delprovider": {
      if (!arg) {
        error("/delprovider <プロバイダーID>");
        return undefined;
      }
      try {
        await core.removeUserProvider(arg.trim());
        success("プロバイダーを削除しました");
      } catch (e) {
        error(errorText(e));
      }
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
