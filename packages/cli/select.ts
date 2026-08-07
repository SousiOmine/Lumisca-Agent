import { formatModelMeta, type LumiscaCore } from "@lumisca/core";
import { color, error, getPromptFn, header, info, success } from "./ui.ts";

export interface Choice<T> {
  label: string;
  value: T;
}

/** Interactive search + numbered selection over a list. */
export async function selectFromList<T>(
  title: string,
  choices: Choice<T>[],
  searchable: (value: T, query: string) => boolean = () => false,
): Promise<T | null> {
  header(title);
  if (choices.length === 0) {
    info("該当する項目がありません");
    return null;
  }

  let query = "";
  let filtered = choices;

  for (;;) {
    const shown = filtered.slice(0, 30);
    for (let i = 0; i < shown.length; i++) {
      console.log(
        `  ${color.yellow(String(i + 1).padStart(2))}  ${shown[i]!.label}`,
      );
    }
    if (filtered.length > shown.length) {
      info(`...ほか ${filtered.length - shown.length} 件`);
    }
    const input = await getPromptFn()(
      `選択 (${
        query ? `検索: ${query}` : "番号で選択 / 文字で検索"
      } / 空Enterで戻る)`,
    );
    if (input === null) return null;
    const trimmed = input.trim();
    if (trimmed === "") return null;
    const n = Number(trimmed);
    if (Number.isInteger(n) && n >= 1 && n <= filtered.length) {
      return filtered[n - 1]!.value;
    }
    // treat as search query
    const q = trimmed.toLowerCase();
    filtered = choices.filter((c) =>
      c.label.toLowerCase().includes(q) ||
      searchable(c.value, q)
    );
    query = q;
    if (filtered.length === 0) {
      info("該当なし");
      filtered = choices;
      query = "";
    }
  }
}

/** One-line session label (name + model, optionally with the updated
 * date). Shared by every session list so they cannot drift apart. */
export function sessionLabel(
  s: {
    name: string;
    modelProvider: string;
    modelId: string;
    updatedAt?: number;
  },
  opts: { date?: boolean } = {},
): string {
  const meta = opts.date && s.updatedAt !== undefined
    ? `${s.modelProvider}/${s.modelId} (${
      new Date(s.updatedAt).toLocaleString()
    })`
    : `${s.modelProvider}/${s.modelId}`;
  return `${s.name} ${color.faint(meta)}`;
}

/** Interactive workspace creation (prompts for folders + name). */
async function createWorkspaceFlow(core: LumiscaCore): Promise<string | null> {
  header("ワークスペースの作成");
  info("作業フォルダのパスを入力してください(複数ある場合はカンマ区切り)");
  const input = await getPromptFn()("フォルダ:");
  if (input === null) return null;
  const folders = input.split(",").map((f) => f.trim()).filter((f) =>
    f.length > 0
  );
  if (folders.length === 0) {
    error("フォルダが指定されていません");
    return null;
  }
  const name = await getPromptFn()("ワークスペース名:") ?? folders[0]!;
  try {
    const ws = await core.createWorkspace(name, folders);
    success(`ワークスペース作成: ${ws.name} (${ws.folders.length} フォルダ)`);
    return ws.id;
  } catch (e) {
    error(e instanceof Error ? e.message : String(e));
    return null;
  }
}

/** Sentinel choice value for "create a new workspace". */
const CREATE_NEW = "__create__";

/** Pick a workspace, or create one. The create option is always offered,
 * not just when no workspace exists yet. */
export async function pickWorkspace(core: LumiscaCore): Promise<string | null> {
  const workspaces = core.listWorkspaces();
  if (workspaces.length === 0) return createWorkspaceFlow(core);

  const id = await selectFromList(
    "ワークスペースを選択",
    [
      ...workspaces.map((w) => ({
        label: `${w.name} ${
          color.faint(`(${w.folders.length} folders: ${w.folders.join(", ")})`)
        }`,
        value: w.id,
      })),
      { label: color.cyan("＋ 新しいワークスペースを作成"), value: CREATE_NEW },
    ],
  );
  if (id === null) return null;
  if (id === CREATE_NEW) return createWorkspaceFlow(core);
  return id;
}

/** Pick a model (provider → model). Only providers that resolve auth
 * locally (env var or stored API key) and models enabled in settings are
 * offered, mirroring the web UI. */
export async function pickModel(core: LumiscaCore): Promise<
  {
    providerId: string;
    modelId: string;
  } | null
> {
  const providers = core.listProviders();
  const available = (
    await Promise.all(
      providers.map(async (p) => ({
        p,
        configured: await core.hasProviderAuth(p.id),
      })),
    )
  ).filter((entry) => entry.configured);
  if (available.length === 0) {
    error(
      "認証済みのプロバイダーがありません。/keys で APIキーを設定してください。",
    );
    return null;
  }

  const providerId = await selectFromList(
    "プロバイダーを選択",
    available.map(({ p }) => ({ label: p.name, value: p.id })),
    (id, q) => id.toLowerCase().includes(q),
  );
  if (providerId === null) return null;

  const models = core.listModelsDetailed(providerId)
    .filter((m) => m.enabled)
    .map((m) => ({
      id: m.id,
      reasoning: m.reasoning,
      contextWindow: m.contextWindow,
    }));
  const modelId = await selectFromList(
    `モデルを選択 (${models.length} 件)`,
    models.map((m) => {
      const meta = formatModelMeta(m.contextWindow, m.reasoning);
      return {
        label: meta ? `${m.id} ${color.faint(meta)}` : m.id,
        value: m.id,
      };
    }),
    (id, q) => id.toLowerCase().includes(q),
  );
  if (modelId === null) return null;
  return { providerId, modelId };
}
