import { useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { IconArrowLeft } from "@tabler/icons-react";
import type { McpServerInfo } from "../../types.ts";

/** Parse textarea lines into a string list (blanks removed). */
function parseLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Parse `key=value` lines into a record (first `=` wins per line). */
function parseKeyValues(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of parseLines(text)) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

function joinKeyValues(record: Record<string, string>): string {
  return Object.entries(record)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

/** A labeled full-width field (label above, input below — matches the
 * other settings forms). */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <p className="settings-note">{label}</p>
      {children}
    </div>
  );
}

const fullWidth: CSSProperties = { width: "100%" };

/** Placeholders with real newlines: JSX attribute strings do not process
 * escape sequences, so these stay in JS string literals. */
const ARGS_PLACEHOLDER = "例:\n-y\n@modelcontextprotocol/server-filesystem\n.";
const ENV_PLACEHOLDER = "例:\nTOKEN=abc123";
const HEADERS_PLACEHOLDER = "例:\nAuthorization=Bearer x";

/** Edit (or create) one MCP server. Saving calls back with the assembled
 * server; the list persists it. */
export function McpDetail({
  initial,
  existingNames,
  onSave,
  onCancel,
}: {
  initial: McpServerInfo | null;
  existingNames: string[];
  onSave: (server: McpServerInfo) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [type, setType] = useState<"stdio" | "http">(initial?.type ?? "stdio");
  const [command, setCommand] = useState(initial?.command ?? "");
  const [args, setArgs] = useState(initial?.args.join("\n") ?? "");
  const [cwd, setCwd] = useState(initial?.cwd ?? "");
  const [env, setEnv] = useState(joinKeyValues(initial?.env ?? {}));
  const [url, setUrl] = useState(initial?.url ?? "");
  const [headers, setHeaders] = useState(
    joinKeyValues(initial?.headers ?? {}),
  );
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("名前を入力してください");
      return;
    }
    if (initial === null && existingNames.includes(trimmed)) {
      setError(`サーバー「${trimmed}」は既に存在します`);
      return;
    }
    if (type === "stdio" && !command.trim()) {
      setError("コマンドを入力してください");
      return;
    }
    if (type === "http" && !url.trim()) {
      setError("URL を入力してください");
      return;
    }
    onSave({
      name: trimmed,
      type,
      enabled: initial?.enabled ?? true,
      command: type === "stdio" ? command.trim() : undefined,
      args: type === "stdio" ? parseLines(args) : [],
      env: parseKeyValues(env),
      cwd: cwd.trim() || undefined,
      url: type === "http" ? url.trim() : undefined,
      headers: type === "http" ? parseKeyValues(headers) : {},
      toolCount: 0,
      status: "not_started",
    });
  };

  return (
    <>
      <div className="modal-header">
        <button type="button" className="btn" onClick={onCancel}>
          <IconArrowLeft size={14} /> 戻る
        </button>
        <h2>{initial ? `編集: ${initial.name}` : "サーバーを追加"}</h2>
        <button type="button" className="btn push" onClick={onCancel}>
          閉じる
        </button>
      </div>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 10,
          fontSize: 13,
        }}
      >
        <Field label="名前">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例: filesystem"
            style={fullWidth}
          />
        </Field>

        <Field label="種類">
          <select
            value={type}
            onChange={(e) => setType(e.target.value as "stdio" | "http")}
            style={fullWidth}
          >
            <option value="stdio">stdio (子プロセス)</option>
            <option value="http">HTTP (streamable)</option>
          </select>
        </Field>

        {type === "stdio"
          ? (
            <>
              <Field label="コマンド">
                <input
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  placeholder="例: npx"
                  style={fullWidth}
                />
              </Field>
              <Field label="引数 (1行に1つ)">
                <textarea
                  rows={3}
                  value={args}
                  onChange={(e) => setArgs(e.target.value)}
                  placeholder={ARGS_PLACEHOLDER}
                  style={{ ...fullWidth, fontFamily: "monospace" }}
                />
              </Field>
              <Field label="作業ディレクトリ (省略可)">
                <input
                  value={cwd}
                  onChange={(e) => setCwd(e.target.value)}
                  placeholder="ワークスペース基準の相対パス"
                  style={fullWidth}
                />
              </Field>
            </>
          )
          : (
            <Field label="URL">
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.com/mcp"
                style={fullWidth}
              />
            </Field>
          )}

        <Field label="環境変数 (key=value、1行に1つ、${VAR} 展開可)">
          <textarea
            rows={3}
            value={env}
            onChange={(e) => setEnv(e.target.value)}
            placeholder={ENV_PLACEHOLDER}
            style={{ ...fullWidth, fontFamily: "monospace" }}
          />
        </Field>

        {type === "http" && (
          <Field label="HTTPヘッダー (key=value、1行に1つ)">
            <textarea
              rows={3}
              value={headers}
              onChange={(e) => setHeaders(e.target.value)}
              placeholder={HEADERS_PLACEHOLDER}
              style={{ ...fullWidth, fontFamily: "monospace" }}
            />
          </Field>
        )}

        {error && <p className="error-text">{error}</p>}
      </div>

      <div className="modal-actions">
        <button type="button" className="btn" onClick={onCancel}>
          キャンセル
        </button>
        <button type="button" className="btn primary" onClick={submit}>
          保存
        </button>
      </div>
    </>
  );
}
