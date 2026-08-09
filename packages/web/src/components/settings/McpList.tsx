import { useEffect, useState } from "react";
import {
  IconAlertTriangle,
  IconChevronRight,
  IconCircleDashed,
  IconPlugConnected,
  IconPlus,
  IconTrash,
} from "@tabler/icons-react";
import type { McpInfo, McpServerInfo } from "../../types.ts";
import { api } from "../../api.ts";
import { errorText } from "../../providers.ts";
import { McpDetail } from "./McpDetail.tsx";

/** Build the `.mcp.json` text for a server list (UI → PUT body). */
export function serversToJson(servers: McpServerInfo[]): string {
  const mcpServers: Record<string, unknown> = {};
  for (const server of servers) {
    const entry: Record<string, unknown> = {};
    if (server.type === "stdio") {
      entry.command = server.command ?? "";
      if (server.args.length > 0) entry.args = server.args;
    } else {
      entry.url = server.url ?? "";
      if (Object.keys(server.headers).length > 0) {
        entry.headers = server.headers;
      }
    }
    if (Object.keys(server.env).length > 0) entry.env = server.env;
    if (server.cwd !== undefined && server.cwd.length > 0) {
      entry.cwd = server.cwd;
    }
    if (!server.enabled) entry.enabled = false;
    mcpServers[server.name] = entry;
  }
  return JSON.stringify({ mcpServers }, null, 2);
}

/** Config-relevant fields only; ignores live status/toolCount so the
 * stale-edit comparison stays stable. */
function configKey(servers: McpServerInfo[]): string {
  return JSON.stringify(
    servers.map((s) => ({
      name: s.name,
      type: s.type,
      enabled: s.enabled,
      command: s.command,
      args: s.args,
      env: s.env,
      cwd: s.cwd,
      url: s.url,
      headers: s.headers,
    })),
  );
}

/** Settings → MCP servers. Manages the app-level (global) config, which
 * applies to every workspace; each workspace's own `.mcp.json` is merged in
 * automatically by the server and is not editable here. */
export function McpList() {
  const [config, setConfig] = useState<McpInfo | null>(null);
  const [baseline, setBaseline] = useState<McpInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<McpServerInfo | null | undefined>(
    undefined, // undefined = list view, null = adding a new server
  );

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const info = await api.getMcpConfig();
      setConfig(info);
      setBaseline(info);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  /** Persist a full server list; asks before clobbering external edits. */
  const save = async (servers: McpServerInfo[]): Promise<boolean> => {
    setError(null);
    try {
      if (baseline) {
        const current = await api.getMcpConfig();
        if (configKey(current.servers) !== configKey(baseline.servers)) {
          if (
            !globalThis.confirm(
              "MCP設定が外部で変更されています。上書き保存しますか？",
            )
          ) {
            return false;
          }
        }
      }
      const info = await api.putMcpConfig(serversToJson(servers));
      setConfig(info);
      setBaseline(info);
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    }
  };

  const toggle = (name: string) => {
    if (!config) return;
    void save(
      config.servers.map((s) =>
        s.name === name ? { ...s, enabled: !s.enabled } : s
      ),
    );
  };

  const remove = (name: string) => {
    if (!config) return;
    if (!globalThis.confirm(`MCPサーバー「${name}」を削除しますか？`)) return;
    void save(config.servers.filter((s) => s.name !== name));
  };

  if (editing !== undefined) {
    return (
      <McpDetail
        initial={editing}
        existingNames={config?.servers.map((s) => s.name) ?? []}
        onSave={(server) => {
          const servers = config
            ? [
              ...config.servers.filter((s) => s.name !== server.name),
              server,
            ]
            : [server];
          void save(servers).then((ok) => {
            if (ok) setEditing(undefined);
          });
        }}
        onCancel={() => setEditing(undefined)}
      />
    );
  }

  return (
    <>
      <div className="modal-header">
        <h2>MCP サーバー</h2>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <p className="settings-note">
          アプリ全体で使うMCPサーバーです(全ワークスペースに適用)。
          各ワークスペースの .mcp.json も自動的にマージされます。
        </p>

        {error && <p className="error-text">{error}</p>}
        {loading && <p className="settings-note">読み込み中…</p>}
        {!loading && config && config.servers.length === 0 && (
          <div className="faint-box">
            MCPサーバーはまだありません。下の「サーバーを追加」から始めてください。
          </div>
        )}
        {!loading &&
          config?.servers.map((s) => (
            <div
              key={s.name}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "8px 10px",
                background: "var(--surface-2)",
                borderRadius: 8,
              }}
            >
              <button
                type="button"
                className="btn"
                style={{
                  flex: 1,
                  textAlign: "left",
                  display: "flex",
                  gap: 8,
                  alignItems: "center",
                }}
                onClick={() => setEditing(s)}
              >
                <span style={{ flex: 1 }}>
                  {s.name}
                  <span className="settings-note" style={{ marginLeft: 8 }}>
                    {s.type === "stdio" ? "stdio" : "http"}
                  </span>
                </span>
                <span className="provider-state configured">
                  {s.status === "ok"
                    ? (
                      <>
                        <IconPlugConnected size={12} />
                        {s.toolCount} tools
                      </>
                    )
                    : s.status === "error"
                    ? (
                      <>
                        <IconAlertTriangle size={12} />
                        エラー
                      </>
                    )
                    : (
                      <>
                        <IconCircleDashed size={12} />
                        未起動
                      </>
                    )}
                </span>
                <IconChevronRight size={14} />
              </button>
              <label
                className="settings-note"
                style={{
                  display: "flex",
                  flexDirection: "row",
                  gap: 4,
                  alignItems: "center",
                }}
              >
                <input
                  type="checkbox"
                  checked={s.enabled}
                  onChange={() => toggle(s.name)}
                />
                有効
              </label>
              <button
                type="button"
                className="btn"
                title={`${s.name} を削除`}
                onClick={() => remove(s.name)}
              >
                <IconTrash size={13} />
                削除
              </button>
            </div>
          ))}
      </div>

      <div className="modal-actions">
        <button
          type="button"
          className="btn primary"
          onClick={() => setEditing(null)}
          disabled={!config}
        >
          <IconPlus size={14} />
          サーバーを追加
        </button>
      </div>
    </>
  );
}
