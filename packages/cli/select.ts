import type { LumiscaCore } from "@lumisca/core";
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

/** Pick or create a workspace. */
export async function pickWorkspace(core: LumiscaCore): Promise<string | null> {
  const workspaces = core.listWorkspaces();
  if (workspaces.length === 0) {
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

  const id = await selectFromList(
    "ワークスペースを選択",
    workspaces.map((w) => ({
      label: `${w.name} ${
        color.faint(`(${w.folders.length} folders: ${w.folders.join(", ")})`)
      }`,
      value: w.id,
    })),
  );
  if (id === null) {
    // offer to create a new one
    const yes = await getPromptFn()(
      "新しいワークスペースを作成しますか? (y/N)",
    );
    if (yes?.toLowerCase() === "y") return pickWorkspace(core);
    return null;
  }
  return id;
}

/** Pick a model (provider → model). */
export async function pickModel(core: LumiscaCore): Promise<
  {
    providerId: string;
    modelId: string;
  } | null
> {
  const providers = core.models.getProviders();
  const providerId = await selectFromList(
    "プロバイダーを選択",
    providers.map((p) => ({ label: p.name, value: p.id })),
    (id, q) => id.toLowerCase().includes(q),
  );
  if (providerId === null) return null;

  const models = core.models.getModels(providerId);
  const modelId = await selectFromList(
    `モデルを選択 (${models.length} 件)`,
    models.map((m) => ({
      label: `${m.id}${m.reasoning ? " 🧠" : ""}${
        m.contextWindow
          ? ` ${color.faint(`${Math.round(m.contextWindow / 1024)}K ctx`)}`
          : ""
      }`,
      value: m.id,
    })),
    (id, q) => id.toLowerCase().includes(q),
  );
  if (modelId === null) return null;
  return { providerId, modelId };
}
