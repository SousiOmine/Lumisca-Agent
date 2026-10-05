import { useState } from "preact/compat";
import type { CSSProperties } from "preact/compat";
import { IconArrowLeft } from "@tabler/icons-preact";
import { serializeMcpServers } from "@lumisca/core/shared";
import type { McpServerInfo, McpTestTool } from "../../types.ts";
import { api } from "../../api.ts";
import { errorText } from "../../providers.ts";
import { useT } from "../../i18n.ts";
import { Field } from "../Field.tsx";
import { mcpDraftKey } from "./mcpDraft.ts";

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

/** Answer of the last connection test, tagged with the fingerprint of the
 * draft it ran against. */
interface McpTestState {
  key: string;
  status: "testing" | "ok" | "error";
  tools: McpTestTool[];
  error?: string;
}

/** Edit (or create) one MCP server. Saving calls back with the assembled
 * server; the list persists it.
 *
 * A new server can be tested before it is added: the primary button stays
 * disabled until a test has reached the server and listed its tools, so a
 * broken command cannot enter the config unnoticed. Editing is not gated —
 * the server is already saved and its status is visible in the list. */
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
  const [test, setTest] = useState<McpTestState | null>(null);
  /** Whether the add button is unlocked: set by every finished test, so a
   * test the user runs after editing and that fails locks it again. */
  const [passed, setPassed] = useState(false);
  const adding = initial === null;

  /** The server the form currently describes. Built on every render, so a
   * test result can be matched against what is on screen right now. */
  const draft: McpServerInfo = {
    name: name.trim(),
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
  };
  const draftKey = mcpDraftKey(draft);
  /** The form has what the selected type needs to connect. */
  const target = draft.type === "stdio" ? draft.command : draft.url;
  const complete = draft.name !== "" && target !== undefined;
  /** The last test's answer, when it belongs to the current form. A result
   * of an earlier edit is never shown as if it described this one. */
  const result = test !== null && test.key === draftKey ? test : null;
  const testing = test?.status === "testing";

  /** Report the first problem of the form; false means "do not continue". */
  const validate = (): boolean => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError(t("settings.mcp.nameEmpty"));
      return false;
    }
    if (adding && existingNames.includes(trimmed)) {
      setError(t("settings.mcp.nameExists", { name: trimmed }));
      return false;
    }
    if (type === "stdio" && !command.trim()) {
      setError(t("settings.mcp.commandEmpty"));
      return false;
    }
    if (type === "http" && !url.trim()) {
      setError(t("settings.mcp.urlEmpty"));
      return false;
    }
    return true;
  };

  const submit = () => {
    if (!validate()) return;
    onSave(draft);
  };

  /** Run the server-side probe against the draft. The browser cannot spawn
   * a stdio server, so the server connects, lists the tools and
   * disconnects; a server that does not answer is a result, not an error. */
  const runTest = async () => {
    if (!validate()) return;
    const key = draftKey;
    setError(null);
    setTest({ key, status: "testing", tools: [] });
    try {
      const answer = await api.testMcpServer(serializeMcpServers([draft]));
      setTest({
        key,
        status: answer.ok ? "ok" : "error",
        tools: answer.tools,
        ...(answer.error !== undefined ? { error: answer.error } : {}),
      });
      setPassed(answer.ok);
    } catch (e) {
      // Reaching our own server failed (it restarted mid-test); report it
      // like a probe failure.
      setTest({ key, status: "error", tools: [], error: errorText(e) });
      setPassed(false);
    }
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

        {result?.status === "ok" && (
          <div style={{ fontSize: 12.5 }}>
            <p style={{ margin: 0, color: "var(--ok)" }}>
              {result.tools.length > 0
                ? t("settings.mcp.testOk", { count: result.tools.length })
                : t("settings.mcp.testNoTools")}
            </p>
            {result.tools.length > 0 && (
              <div
                style={{
                  marginTop: 6,
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  padding: "6px 8px",
                  maxHeight: 240,
                  overflowY: "auto",
                }}
              >
                <p className="settings-note" style={{ margin: "0 0 4px" }}>
                  {t("settings.mcp.testTools")}
                </p>
                {result.tools.map((tool) => (
                  <div key={tool.name} style={{ margin: "4px 0" }}>
                    <div style={{ fontFamily: "var(--mono)" }}>{tool.name}</div>
                    {tool.description !== undefined && (
                      <div
                        className="settings-note"
                        style={{ whiteSpace: "pre-wrap" }}
                      >
                        {tool.description}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {result?.status === "error" && (
          <p className="error-text" style={{ margin: 0 }}>
            {t("settings.mcp.testFailed", { error: result.error ?? "" })}
          </p>
        )}

        {test !== null && result === null && (
          <p className="settings-note">{t("settings.mcp.testStale")}</p>
        )}

        {adding && !passed && (
          <p className="settings-note">{t("settings.mcp.testRequired")}</p>
        )}
      </div>

      <div className="modal-actions">
        <button type="button" className="btn" onClick={onCancel}>
          {t("common.cancel")}
        </button>
        {complete && (
          <button
            type="button"
            className="btn"
            disabled={testing}
            onClick={() => void runTest()}
          >
            {testing ? t("settings.mcp.testing") : t("settings.mcp.test")}
          </button>
        )}
        <button
          type="button"
          className="btn primary"
          disabled={adding && !passed}
          onClick={submit}
        >
          {t("common.save")}
        </button>
      </div>
    </>
  );
}
