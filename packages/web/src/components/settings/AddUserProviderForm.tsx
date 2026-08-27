import { useEffect, useState } from "react";
import {
  IconArrowLeft,
  IconCheck,
  IconPlus,
  IconTrash,
} from "@tabler/icons-react";
import { api } from "../../api.ts";
import { errorText } from "../../providers.ts";
import type { UserProviderSummary } from "../../types.ts";

const ALLOWED_OPENAI_APIS = [
  "openai-completions",
  "openai-responses",
] as const;

/** One model row in the form. Mirrors UserProviderModel; empty-string
 * numeric fields mean "use provider default". */
interface ModelRow {
  id: string;
  name: string;
  reasoning: boolean;
  image: boolean;
  contextWindow: string;
  maxTokens: string;
}

interface HeaderRow {
  key: string;
  value: string;
}

/** Suggest a provider id from a display name: lowercase, alphanumerics and
 * `.`/`_`/`-` only, collapses separators. Used only to prefill the id
 * field — the user can still edit it. */
function idFromName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function emptyModel(): ModelRow {
  return {
    id: "",
    name: "",
    reasoning: false,
    image: false,
    contextWindow: "",
    maxTokens: "",
  };
}

function ModelRowEditor({
  row,
  canRemove,
  onChange,
  onRemove,
}: {
  row: ModelRow;
  canRemove: boolean;
  onChange: (next: ModelRow) => void;
  onRemove: () => void;
}) {
  const set = (patch: Partial<ModelRow>) => onChange({ ...row, ...patch });
  return (
    <div className="user-provider-card">
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <input
          placeholder="モデルID (例: gpt-4o)"
          value={row.id}
          onChange={(e) => set({ id: e.target.value })}
          style={{ flex: 1 }}
        />
        <button
          type="button"
          className="btn small"
          disabled={!canRemove}
          onClick={onRemove}
        >
          <IconTrash size={14} />
        </button>
      </div>
      <input
        placeholder="表示名（任意）"
        value={row.name}
        onChange={(e) => set({ name: e.target.value })}
      />
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input
            type="checkbox"
            checked={row.reasoning}
            onChange={(e) => set({ reasoning: e.target.checked })}
          />
          推論モード対応
        </label>
        <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input
            type="checkbox"
            checked={row.image}
            onChange={(e) => set({ image: e.target.checked })}
          />
          画像入力対応
        </label>
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <input
          placeholder="コンテキストウィンドウ (トークン)"
          value={row.contextWindow}
          inputMode="numeric"
          onChange={(e) => set({ contextWindow: e.target.value })}
          style={{ flex: 1 }}
        />
        <input
          placeholder="最大出力 (トークン)"
          value={row.maxTokens}
          inputMode="numeric"
          onChange={(e) => set({ maxTokens: e.target.value })}
          style={{ flex: 1 }}
        />
      </div>
    </div>
  );
}

function HeaderRowEditor({
  row,
  onChange,
  onRemove,
}: {
  row: HeaderRow;
  onChange: (next: HeaderRow) => void;
  onRemove: () => void;
}) {
  return (
    <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
      <input
        placeholder="ヘッダー名"
        value={row.key}
        onChange={(e) => onChange({ ...row, key: e.target.value })}
        style={{ flex: 1 }}
      />
      <input
        placeholder="値"
        value={row.value}
        onChange={(e) => onChange({ ...row, value: e.target.value })}
        style={{ flex: 1 }}
      />
      <button type="button" className="btn small" onClick={onRemove}>
        <IconTrash size={14} />
      </button>
    </div>
  );
}

/** Settings → add/edit a custom OpenAI-compatible provider. `mode: "edit"`
 * loads `initial` and fixes the id; "create" lets the user pick an id. */
export function AddUserProviderForm({
  mode,
  initial,
  onBack,
  onDone,
  onDeleted,
}: {
  mode: "create" | "edit";
  initial?: UserProviderSummary;
  onBack: () => void;
  onDone: (providerId: string) => void;
  onDeleted?: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [id, setId] = useState(initial?.id ?? "");
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? "");
  const [providerApi, setProviderApi] = useState<string>(
    initial?.api ?? ALLOWED_OPENAI_APIS[0]!,
  );
  const [headers, setHeaders] = useState<HeaderRow[]>(
    initial?.headers
      ? Object.entries(initial.headers).map(([key, value]) => ({ key, value }))
      : [],
  );
  const [models, setModels] = useState<ModelRow[]>(
    initial?.models?.length
      ? initial.models.map((m) => ({
        id: m.id,
        name: m.name ?? "",
        reasoning: m.reasoning ?? false,
        image: (m.input ?? []).includes("image"),
        contextWindow: m.contextWindow ? String(m.contextWindow) : "",
        maxTokens: m.maxTokens ? String(m.maxTokens) : "",
      }))
      : [emptyModel()],
  );
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [idTouched, setIdTouched] = useState(mode === "edit");

  // Restore initial values when editing a different provider.
  useEffect(() => {
    if (mode === "edit" && initial) {
      setName(initial.name ?? "");
      setId(initial.id ?? "");
      setBaseUrl(initial.baseUrl ?? "");
      setProviderApi(initial.api ?? ALLOWED_OPENAI_APIS[0]!);
      setHeaders(
        initial.headers
          ? Object.entries(initial.headers).map(([k, v]) => ({ key: k, value: v }))
          : [],
      );
      setModels(
        initial.models?.length
          ? initial.models.map((m) => ({
            id: m.id,
            name: m.name ?? "",
            reasoning: m.reasoning ?? false,
            image: (m.input ?? []).includes("image"),
            contextWindow: m.contextWindow ? String(m.contextWindow) : "",
            maxTokens: m.maxTokens ? String(m.maxTokens) : "",
          }))
          : [emptyModel()],
      );
      setApiKey("");
      setIdTouched(true);
    }
  }, [initial?.id]);

  // Keep the suggested id in sync with the name until the user edits it.
  useEffect(() => {
    if (!idTouched && mode === "create") setId(idFromName(name));
  }, [name, idTouched, mode]);

  const submit = async () => {
    setError(undefined);
    const headerMap: Record<string, string> = {};
    for (const h of headers) {
      if (h.key.trim() === "") continue;
      if (h.key in headerMap) {
        setError(`重複するヘッダー名: ${h.key}`);
        return;
      }
      headerMap[h.key] = h.value;
    }
    const modelDefs = models.map((m) => ({
      id: m.id.trim(),
      ...(m.name.trim() ? { name: m.name.trim() } : {}),
      ...(m.reasoning ? { reasoning: true } : {}),
      ...(m.image ? { input: ["text", "image"] as ("text" | "image")[] } : {}),
      ...(m.contextWindow.trim() ? { contextWindow: Number(m.contextWindow) } : {}),
      ...(m.maxTokens.trim() ? { maxTokens: Number(m.maxTokens) } : {}),
    }));

    const input = {
      id: id.trim(),
      name: name.trim(),
      baseUrl: baseUrl.trim(),
      api: providerApi,
      ...(Object.keys(headerMap).length > 0 ? { headers: headerMap } : {}),
      models: modelDefs,
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
    };

    setSaving(true);
    try {
      const result = mode === "create"
        ? await api.createUserProvider(input)
        : await api.updateUserProvider(id.trim(), input);
      onDone(result.id);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  const idEditable = mode === "create";

  const updateModel = (index: number, next: ModelRow) =>
    setModels((cur) => cur.map((c, j) => (j === index ? next : c)));
  const removeModel = (index: number) =>
    setModels((cur) => cur.filter((_, j) => j !== index));
  const updateHeader = (index: number, next: HeaderRow) =>
    setHeaders((cur) => cur.map((c, j) => (j === index ? next : c)));
  const removeHeader = (index: number) =>
    setHeaders((cur) => cur.filter((_, j) => j !== index));

  const handleDelete = async () => {
    if (!initial?.id) return;
    if (!confirm(`プロバイダー "${initial.name}" を削除しますか？`)) return;
    setDeleting(true);
    setError(undefined);
    try {
      await api.deleteUserProvider(initial.id);
      onDeleted?.();
      onBack();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      <div className="modal-header">
        <button type="button" className="btn" onClick={onBack}>
          <IconArrowLeft size={14} /> 戻る
        </button>
        <h2>
          {mode === "create"
            ? "カスタムプロバイダーを追加"
            : "カスタムプロバイダーを編集"}
        </h2>
      </div>

      <div className="settings-pane" style={{ gap: 10 }}>
        <label className="field">
          <span>表示名</span>
          <input
            placeholder="例: 自宅 vLLM"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>

        <label className="field">
          <span>プロバイダーID</span>
          <input
            placeholder="例: home-vllm"
            value={id}
            disabled={!idEditable}
            onChange={(e) => {
              setIdTouched(true);
              setId(e.target.value);
            }}
          />
          <p className="settings-note">
            {idEditable
              ? "モデル指定で使う識別子 (例: home-vllm/gpt-4o)。英数字・. _ - のみ"
              : "編集時は変更できません"}
          </p>
        </label>

        <label className="field">
          <span>Base URL</span>
          <input
            placeholder="https://api.example.com/v1"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
          <p className="settings-note">
            OpenAI 互換エンドポイントの基底 URL (通常は /v1 まで)
          </p>
        </label>

        <label className="field">
          <span>API</span>
          <select value={providerApi} onChange={(e) => setProviderApi(e.target.value)}>
            {ALLOWED_OPENAI_APIS.map((a) => (
              <option key={a} value={a}>{a}</option>
            ))}
          </select>
          <p className="settings-note">モデルが未指定の場合の既定 API</p>
        </label>

        <label className="field">
          <span>APIキー {mode === "edit" && "(空白で維持)"}</span>
          <input
            type="password"
            placeholder={initial?.hasApiKey ? "設定済み（上書き）" : "APIキー"}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
        </label>

        <div>
          <p className="settings-note">カスタムヘッダー（任意）</p>
          {headers.map((h, i) => (
            <HeaderRowEditor
              key={i}
              row={h}
              onChange={(next) => updateHeader(i, next)}
              onRemove={() => removeHeader(i)}
            />
          ))}
          <button
            type="button"
            className="btn small"
            onClick={() => setHeaders((cur) => [...cur, { key: "", value: "" }])}
          >
            <IconPlus size={14} /> ヘッダーを追加
          </button>
        </div>

        <div>
          <p className="settings-note">モデル（1つ以上）</p>
          {models.map((m, i) => (
            <ModelRowEditor
              key={i}
              row={m}
              canRemove={models.length > 1}
              onChange={(next) => updateModel(i, next)}
              onRemove={() => removeModel(i)}
            />
          ))}
          <button
            type="button"
            className="btn small"
            onClick={() => setModels((cur) => [...cur, emptyModel()])}
          >
            <IconPlus size={14} /> モデルを追加
          </button>
        </div>

        {error && <div className="error-text">{error}</div>}
      </div>

      <div className="modal-actions">
        {mode === "edit" && (
          <button
            type="button"
            className="btn danger"
            onClick={handleDelete}
            disabled={deleting || saving}
          >
            <IconTrash size={14} /> 削除
          </button>
        )}
        <button
          type="button"
          className="btn primary"
          onClick={submit}
          disabled={saving || deleting}
        >
          <IconCheck size={14} />
          {mode === "create" ? "追加" : "保存"}
        </button>
      </div>
    </>
  );
}
