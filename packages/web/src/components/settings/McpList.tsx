import { useEffect, useState } from "preact/compat";
import {
  IconAlertTriangle,
  IconCheck,
  IconChevronRight,
  IconCircleDashed,
  IconCopy,
  IconExternalLink,
  IconLoader2,
  IconLogin2,
  IconPlugConnected,
  IconPlus,
  IconTrash,
} from "@tabler/icons-preact";
import { serializeMcpServers } from "@lumisca/core/shared";
import type { McpInfo, McpServerInfo } from "../../types.ts";
import { api } from "../../api.ts";
import { errorText } from "../../providers.ts";
import { useT } from "../../i18n.ts";
import { useMcpSignIn } from "../../hooks/useMcpSignIn.ts";
import { McpDetail } from "./McpDetail.tsx";
import { mcpConfigFields } from "./mcpDraft.ts";

/** Config-relevant key of a whole server list; the live status fields are
 * ignored so the stale-edit comparison stays stable (see mcpConfigFields). */
function configKey(servers: McpServerInfo[]): string {
  return JSON.stringify(servers.map((s) => mcpConfigFields(s)));
}

/** Settings → MCP servers. Manages the app-level (global) config, which
 * applies to every workspace; each workspace's own `.mcp.json` is merged in
 * automatically by the server and is not editable here. */
export function McpList() {
  const t = useT();
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

  /** Sign-in of a saved server (its status says the grant is missing or no
   * longer accepted); the list reloads once the browser came back, so the
   * badge shows what the session sees now. */
  const signIn = useMcpSignIn(() => {
    void load();
  });

  /** Persist a full server list; asks before clobbering external edits. */
  const save = async (servers: McpServerInfo[]): Promise<boolean> => {
    setError(null);
    try {
      if (baseline) {
        const current = await api.getMcpConfig();
        if (configKey(current.servers) !== configKey(baseline.servers)) {
          if (
            !globalThis.confirm(
              t("settings.mcp.configConflict"),
            )
          ) {
            return false;
          }
        }
      }
      const info = await api.putMcpConfig(serializeMcpServers(servers));
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
    if (!globalThis.confirm(t("settings.mcp.deleteConfirm", { name }))) return;
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
        <h2>{t("settings.nav.mcp")}</h2>
      </div>

      <div className="stack-8">
        {error && <p className="error-text">{error}</p>}
        {signIn.error && <p className="error-text">{signIn.error}</p>}
        {loading && <p className="settings-note">{t("common.loading")}</p>}
        {!loading && config && config.servers.length === 0 && (
          <div className="faint-box">
            {t("settings.mcp.noServers")}
          </div>
        )}
        {!loading &&
          config?.servers.map((s) => (
            <div key={s.name} className="setting-card">
              <button
                type="button"
                className="btn setting-card-open"
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
                        {s.needsAuth
                          ? <IconLogin2 size={12} />
                          : <IconAlertTriangle size={12} />}
                        {s.needsAuth
                          ? t("settings.mcp.authNeeded")
                          : t("settings.mcp.error")}
                      </>
                    )
                    : (
                      <>
                        <IconCircleDashed size={12} />
                        {t("settings.mcp.notStarted")}
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
                {t("settings.mcp.enabled")}
              </label>
              {s.needsAuth && (
                <button
                  type="button"
                  className="btn"
                  disabled={signIn.pending}
                  onClick={() => void signIn.start(s)}
                >
                  {signIn.pending
                    ? <IconLoader2 size={13} className="spin" />
                    : <IconExternalLink size={13} />}
                  {signIn.pending
                    ? t("settings.mcp.authWaiting")
                    : t("settings.mcp.authStart")}
                </button>
              )}
              {s.needsAuth && signIn.pending &&
                signIn.authorizationUrl !== null && (
                <button
                  type="button"
                  className="btn"
                  onClick={() => void signIn.copyUrl()}
                >
                  {signIn.copied
                    ? <IconCheck size={13} />
                    : <IconCopy size={13} />}
                  {signIn.copied
                    ? t("settings.mcp.authCopied")
                    : t("settings.mcp.authCopyUrl")}
                </button>
              )}
              <button
                type="button"
                className="btn"
                title={t("common.delete")}
                onClick={() => remove(s.name)}
              >
                <IconTrash size={13} />
                {t("common.delete")}
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
          {t("settings.mcp.addServer")}
        </button>
      </div>
    </>
  );
}
