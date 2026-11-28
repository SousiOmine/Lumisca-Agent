import { errorMessage } from "@lumisca/core/shared";
import { IconRefresh } from "@tabler/icons-preact";
import { useEffect, useState } from "preact/hooks";
import { api } from "../../api.ts";
import { useT } from "../../i18n.ts";
import type { AgentMcpView, McpServerInfo } from "../../types.ts";

/** The two lists as the panel draws them: the agent's own first, and the
 * shared list without the entries this agent overrides. Split out so the
 * rule can be read and tested without a DOM. */
export interface McpPanelSections {
  own: McpServerInfo[];
  shared: McpServerInfo[];
  /** Shared entries hidden because the agent's own list has the name. */
  overshadowed: number;
  empty: boolean;
}

export function mcpPanelSections(
  view: Pick<AgentMcpView, "agent" | "global">,
): McpPanelSections {
  const own = view.agent.servers;
  const ownNames = new Set(own.map((server) => server.name));
  const shared = view.global.servers.filter(
    (server) => !ownNames.has(server.name),
  );
  return {
    own,
    shared,
    overshadowed: view.global.servers.length - shared.length,
    empty: own.length === 0 && view.global.servers.length === 0,
  };
}

export interface AgentMcpServersProps {
  /** The agent whose lists this panel shows. */
  agentId: string;
}

/**
 * The MCP servers one stella conversation uses, read-only.
 *
 * Two lists arrive together (see AgentMcpView): the agent's own, whose
 * servers run inside its machine, and the shared app-level list, whose
 * servers run on the host and are used by every agent. The agent's own list
 * comes first and wins a name collision, so a shared server that this agent
 * overrides is not drawn as if it were the one running.
 *
 * Nothing here edits either list. The agent changes them from the
 * conversation with mcp_add and mcp_remove, which is why the panel only
 * needs a read and a refresh: a list the reader could change here would be a
 * second, silent path into a config the agent owns.
 */
export function AgentMcpServers({ agentId }: AgentMcpServersProps) {
  const t = useT();
  const [view, setView] = useState<AgentMcpView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // A conversation switch must not draw the previous agent's servers: the
    // answer is dropped rather than applied to the new agent.
    let current = true;
    setLoading(true);
    setError(null);
    api
      .getAgentMcpView(agentId)
      .then((next) => {
        if (current) setView(next);
      })
      .catch((caught: unknown) => {
        if (current) setError(errorMessage(caught));
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [agentId]);

  const reload = () => {
    setLoading(true);
    setError(null);
    api
      .getAgentMcpView(agentId)
      .then(setView)
      .catch((caught: unknown) => setError(errorMessage(caught)))
      .finally(() => setLoading(false));
  };

  if (loading && view === null) {
    return <p className="stella-mcp-note">{t("common.loading")}</p>;
  }
  if (error !== null) {
    return <p className="stella-mcp-note stella-mcp-note-error">{error}</p>;
  }
  if (view === null) return null;

  const { own, shared, overshadowed, empty } = mcpPanelSections(view);

  return (
    <div className="stella-mcp">
      {empty && (
        <p className="stella-mcp-note">{t("chat.stella.agentMcp.empty")}</p>
      )}
      {!empty && (
        <>
          {own.length > 0 && (
            <section className="stella-mcp-group">
              <h4 className="stella-mcp-heading">
                {t("chat.stella.agentMcp.own")}
              </h4>
              <ul className="stella-mcp-list">
                {own.map((server) => (
                  <McpRow key={server.name} server={server} />
                ))}
              </ul>
              <p className="stella-mcp-note">
                {t("chat.stella.agentMcp.ownHint")}
              </p>
            </section>
          )}
          {shared.length > 0 && (
            <section className="stella-mcp-group">
              <h4 className="stella-mcp-heading">
                {t("chat.stella.agentMcp.global")}
              </h4>
              <ul className="stella-mcp-list">
                {shared.map((server) => (
                  <McpRow key={server.name} server={server} host />
                ))}
              </ul>
              <p className="stella-mcp-note">
                {t("chat.stella.agentMcp.globalHint")}
              </p>
            </section>
          )}
          {overshadowed > 0 && (
            <p className="stella-mcp-note">
              {t("chat.stella.agentMcp.shadowed", { count: overshadowed })}
            </p>
          )}
          {view.errors.length > 0 && (
            <p className="stella-mcp-note stella-mcp-note-error">
              {view.errors.join("\n")}
            </p>
          )}
        </>
      )}
      <button
        type="button"
        className="stella-settings-toggle stella-mcp-refresh"
        onClick={reload}
        disabled={loading}
      >
        <IconRefresh size={13} />
        <span>{t("common.reload")}</span>
      </button>
    </div>
  );
}

/** One server: its name, which side it runs on, and what it is doing now. */
function McpRow({
  server,
  host = false,
}: {
  server: McpServerInfo;
  /** The row belongs to the shared list, so its process runs on the host. */
  host?: boolean;
}) {
  const t = useT();
  const status = !server.enabled
    ? t("chat.stella.agentMcp.disabled")
    : server.needsAuth === true
      ? t("chat.stella.agentMcp.needsAuth")
      : server.error !== undefined
        ? t("chat.stella.agentMcp.failed")
        : server.status === "not_started"
          ? t("chat.stella.agentMcp.notStarted")
          : t("chat.stella.agentMcp.tools", { count: server.toolCount });
  const bad = server.error !== undefined && server.needsAuth !== true;
  return (
    <li className="stella-mcp-row" title={server.error}>
      <span className="stella-mcp-name">{server.name}</span>
      <span className="stella-mcp-status">{server.type}</span>
      <span
        className={
          bad
            ? "stella-mcp-status stella-mcp-status-error"
            : "stella-mcp-status"
        }
      >
        {status}
      </span>
      {host && server.type === "stdio" && (
        <span className="stella-mcp-status">
          {t("chat.stella.agentMcp.hostSide")}
        </span>
      )}
    </li>
  );
}
