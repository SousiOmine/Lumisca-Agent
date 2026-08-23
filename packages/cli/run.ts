import { realpathSync } from "node:fs";
import { basename } from "node:path";
import {
  type AgentMessage,
  contentText,
  type LumiscaCore,
} from "@lumisca/core";
import { parseFlags } from "./flags.ts";
import {
  type BrowserPreviewMode,
  parseBrowserPreview,
} from "./browser-host.ts";

/** Options of the `lumisca run` command (one-shot headless execution). */
export interface RunOptions {
  /** Database path (defaults to $LUMISCA_DB or ./lumisca.db — the run's
   * session is persisted there like any other). */
  dbPath: string;
  /** Workspace folder (defaults to the current directory). */
  workspacePath: string;
  /** The prompt to execute. */
  prompt: string;
  /** "provider/modelId" model selector; omitted → the default model. */
  model?: string;
  /** Print the full transcript as JSON instead of the final answer text. */
  json: boolean;
  /** Browser-lab policy (default "never" — headless runs do not spawn a
   * GUI host unless explicitly asked). */
  browserPreview: BrowserPreviewMode;
}

/** The outcome of one run: the persisted session and its transcript, plus
 * the session error when the run failed (reported via session_error). */
export interface RunResult {
  sessionId: string;
  provider: string;
  modelId: string;
  messages: AgentMessage[];
  /** The last session error (undefined when the run completed cleanly). */
  error?: string;
}

const RUN_SESSION_PREFIX = "Run ";

/** Parse `lumisca run` flags. Throws with a usage message on invalid
 * input. */
export function parseRunArgs(args: string[]): RunOptions {
  const { values, switches } = parseFlags(
    args,
    [
      { name: "db", hasValue: true },
      { name: "workspace", hasValue: true },
      { name: "prompt", hasValue: true },
      { name: "model", hasValue: true },
      { name: "browser-preview", hasValue: true },
      { name: "json" },
      { name: "help", alias: "-h" },
    ],
    () => {
      throw new HelpRequested();
    },
  );
  const opts: RunOptions = {
    dbPath: values.db ??
      Deno.env.get("LUMISCA_DB") ?? `${Deno.cwd()}/lumisca.db`,
    workspacePath: values.workspace ?? Deno.cwd(),
    prompt: "",
    json: switches.has("json"),
    browserPreview: parseBrowserPreview(values["browser-preview"]),
  };
  if (values.model !== undefined) {
    if (!values.model.includes("/")) {
      throw new Error(
        `--model は "プロバイダ/モデルID" の形式で指定してください (例: custom/deepseek-chat)`,
      );
    }
    opts.model = values.model;
  }
  const promptArg = values.prompt;
  if (promptArg !== undefined) {
    opts.prompt = promptArg;
  } else if (Deno.stdin.isTerminal()) {
    // Interactive terminal without --prompt: do not block waiting for a
    // pipe that will never come — report the missing prompt instead.
    opts.prompt = "";
  } else {
    // Piped stdin: read the prompt from it.
    opts.prompt = readStdin().trim();
  }
  if (opts.prompt === "") {
    throw new Error(
      "プロンプトが必要です: --prompt <text> か stdin で指定してください",
    );
  }
  return opts;
}

/** Read all of stdin as text (blocking; used when --prompt is absent). */
function readStdin(): string {
  const chunks: Uint8Array[] = [];
  const buffer = new Uint8Array(64 * 1024);
  for (;;) {
    const n = Deno.stdin.readSync(buffer);
    if (n === null || n === 0) break; // closed or EOF
    chunks.push(buffer.slice(0, n));
  }
  const total = chunks.reduce((acc, c) => acc + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(out);
}

/** Sentinel for --help (the caller prints the usage text). */
export class HelpRequested extends Error {}

export const RUN_USAGE = `lumisca run — ワンショット実行 (ヘッドレス)

使用法:
  lumisca run [--workspace <dir>] [--prompt <text>] [--model <provider/modelId>] [--json] [--db <path>]
              [--browser-preview <auto|always|never>]

オプション:
  --workspace <dir>   作業フォルダ (既定: カレントディレクトリ)
  --prompt <text>     実行するプロンプト (省略時は stdin から読み取り)
  --model <p/m>       モデル指定 (既定: デフォルトモデル)
  --json              全メッセージを JSON で出力 (既定: 最終回答のみ)
  --db <path>         データベースのパス (既定: $LUMISCA_DB または ./lumisca.db)
  --browser-preview   never(既定) / auto / always — ブラウザの起動方針
                      (ヘッドレス実行は既定で起動しません)

終了コード:
  0  正常完了
  1  実行エラー`;

/** Find a workspace whose folders exactly match the given resolved paths,
 * or create one. Reusing the workspace keeps repeated runs from piling up
 * duplicate rows (the run session itself is new every time). */
async function findOrCreateWorkspace(
  core: LumiscaCore,
  name: string,
  folder: string,
) {
  const existing = core.listWorkspaces().find(
    (w) =>
      w.folders.length === 1 &&
      sameFolder(w.folders[0]!, folder),
  );
  if (existing) return existing;
  return await core.createWorkspace(name, [folder]);
}

/** Case-insensitive folder comparison on Windows (realpath preserves the
 * on-disk casing there, which may differ from the user's spelling). */
function sameFolder(a: string, b: string): boolean {
  if (Deno.build.os === "windows") {
    return a.toLowerCase() === b.toLowerCase();
  }
  return a === b;
}

/** Resolve the run's model: an explicit "provider/modelId", else the
 * last-used model when its provider is configured, else the first enabled
 * model of the first provider with complete auth. (getDefaultModel alone
 * can return an unconfigured builtin model — the interactive picker
 * filters by auth, and the run must do the same.) */
async function resolveRunModel(
  core: LumiscaCore,
  model: string | undefined,
): Promise<{ provider: string; modelId: string }> {
  if (model !== undefined) {
    const [provider, modelId] = model.split("/");
    if (!provider || !modelId) {
      throw new Error(
        `--model は "プロバイダ/モデルID" の形式で指定してください (例: custom/deepseek-chat)`,
      );
    }
    return { provider, modelId };
  }
  const def = core.getDefaultModel();
  if (
    def !== null &&
    core.isModelEnabled(def.provider, def.modelId) &&
    await core.hasProviderAuth(def.provider)
  ) {
    return { provider: def.provider, modelId: def.modelId };
  }
  for (const provider of core.listProviders()) {
    if (!await core.hasProviderAuth(provider.id)) continue;
    const model = core.listModels(provider.id).find((m) =>
      core.isModelEnabled(provider.id, m.id)
    );
    if (model) return { provider: provider.id, modelId: model.id };
  }
  throw new Error(
    "認証済みのモデルがありません (--model で指定するか API キーを設定してください)",
  );
}

/** Execute one headless run: resolve the workspace and model, create a
 * headless session, run the prompt to completion, and return the
 * transcript. Failures reported via session_error or an error assistant
 * message surface as `error` on the result; unexpected errors throw. */
export async function runOnce(
  core: LumiscaCore,
  options: RunOptions,
): Promise<RunResult> {
  const folder = realpathSync(options.workspacePath);
  const workspace = await findOrCreateWorkspace(
    core,
    basename(folder),
    folder,
  );

  const { provider, modelId } = await resolveRunModel(core, options.model);

  const session = core.createSession({
    workspaceId: workspace.id,
    name: `${RUN_SESSION_PREFIX}${new Date().toLocaleString()}`,
    modelProvider: provider,
    modelId,
    headless: true,
  });

  await core.prompt(session.id, options.prompt);

  const messages = core.getAgent(session.id)?.messages ?? [];
  // Model-stream failures end the run with an error assistant message
  // (stopReason "error"); the session_error event only fires when the
  // agent loop itself throws. Check both.
  const error = core.getSessionLastError(session.id) ??
    assistantErrorMessage(messages);
  return { sessionId: session.id, provider, modelId, messages, error };
}

/** The errorMessage of the last assistant message with an error stop
 * reason, or undefined when the run produced no model error. */
function assistantErrorMessage(messages: AgentMessage[]): string | undefined {
  const last = [...messages]
    .reverse()
    .find((m) => m.role === "assistant");
  if (!last) return undefined;
  const { stopReason, errorMessage } = last as {
    stopReason?: string;
    errorMessage?: string;
  };
  if (stopReason === "error") {
    return errorMessage ?? "The model returned an error";
  }
  return undefined;
}

/** The text of the last assistant message, or "" when the run produced
 * none (e.g. a vacant response after the retry limit). */
export function finalAnswerText(messages: AgentMessage[]): string {
  const last = [...messages]
    .reverse()
    .find((m) => m.role === "assistant");
  if (!last) return "";
  const content = (last as { content?: unknown }).content;
  return typeof content === "string"
    ? content
    : contentText(content as Array<{ type: string; text?: string }>);
}

/** Print the run result: the full transcript as JSON (--json) or the
 * final answer text. */
export function printRunResult(result: RunResult, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(
      {
        sessionId: result.sessionId,
        provider: result.provider,
        modelId: result.modelId,
        messages: result.messages,
      },
      null,
      2,
    ));
    return;
  }
  console.log(finalAnswerText(result.messages));
}
