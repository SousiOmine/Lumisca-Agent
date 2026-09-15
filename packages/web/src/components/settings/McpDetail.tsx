import { useState } from "preact/compat";
import type { CSSProperties } from "preact/compat";
import { IconArrowLeft } from "@tabler/icons-preact";
import type { McpServerInfo } from "../../types.ts";
import { useT } from "../../i18n.ts";
import { Field } from "../Field.tsx";

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

const fullWidth: CSSProperties = { width: "100%" };

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
  const t = useT();
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
      setError(t("settings.mcp.nameEmpty"));
      return;
    }
    if (initial === null && existingNames.includes(trimmed)) {
      setError(t("settings.mcp.nameExists", { name: trimmed }));
      return;
    }
    if (type === "stdio" && !command.trim()) {
      setError(t("settings.mcp.commandEmpty"));
      return;
    }
    if (type === "http" && !url.trim()) {
      setError(t("settings.mcp.urlEmpty"));
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
          <IconArrowLeft size={14} /> {t("common.back")}
        </button>
        <h2>
          {initial
            ? t("settings.mcp.editTitle", { name: initial.name })
            : t("settings.mcp.addTitle")}
        </h2>
        <button type="button" className="btn push" onClick={onCancel}>
          {t("common.close")}
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
        <Field label={t("settings.mcp.nameLabel")}>
          <input
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            placeholder={t("settings.mcp.namePlaceholder")}
            style={fullWidth}
          />
        </Field>

        <Field label={t("settings.mcp.typeLabel")}>
          <select
            value={type}
            onChange={(e) => setType(e.currentTarget.value as "stdio" | "http")}
            style={fullWidth}
          >
            <option value="stdio">{t("settings.mcp.typeStdio")}</option>
            <option value="http">{t("settings.mcp.typeHttp")}</option>
          </select>
        </Field>

        {type === "stdio"
          ? (
            <>
              <Field label={t("settings.mcp.commandLabel")}>
                <input
                  value={command}
                  onChange={(e) => setCommand(e.currentTarget.value)}
                  placeholder={t("settings.mcp.commandPlaceholder")}
                  style={fullWidth}
                />
              </Field>
              <Field label={t("settings.mcp.argsLabel")}>
                <textarea
                  rows={3}
                  value={args}
                  onChange={(e) => setArgs(e.currentTarget.value)}
                  placeholder={t("settings.mcp.argsPlaceholder")}
                  style={{ ...fullWidth, fontFamily: "monospace" }}
                />
              </Field>
              <Field label={t("settings.mcp.cwdLabel")}>
                <input
                  value={cwd}
                  onChange={(e) => setCwd(e.currentTarget.value)}
                  placeholder={t("settings.mcp.cwdPlaceholder")}
                  style={fullWidth}
                />
              </Field>
            </>
          )
          : (
            <Field label={t("settings.mcp.urlLabel")}>
              <input
                value={url}
                onChange={(e) => setUrl(e.currentTarget.value)}
                placeholder="https://example.com/mcp"
                style={fullWidth}
              />
            </Field>
          )}

        <Field label={t("settings.mcp.envLabel", { var: "${VAR}" })}>
          <textarea
            rows={3}
            value={env}
            onChange={(e) => setEnv(e.currentTarget.value)}
            placeholder={t("settings.mcp.envPlaceholder")}
            style={{ ...fullWidth, fontFamily: "monospace" }}
          />
        </Field>

        {type === "http" && (
          <Field label={t("settings.mcp.httpHeadersLabel")}>
            <textarea
              rows={3}
              value={headers}
              onChange={(e) => setHeaders(e.currentTarget.value)}
              placeholder={t("settings.mcp.headersPlaceholder")}
              style={{ ...fullWidth, fontFamily: "monospace" }}
            />
          </Field>
        )}

        {error && <p className="error-text">{error}</p>}
      </div>

      <div className="modal-actions">
        <button type="button" className="btn" onClick={onCancel}>
          {t("common.cancel")}
        </button>
        <button type="button" className="btn primary" onClick={submit}>
          {t("common.save")}
        </button>
      </div>
    </>
  );
}
