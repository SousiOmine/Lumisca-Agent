import { useEffect, useState } from "preact/compat";
import type { CSSProperties } from "preact/compat";
import { IconChevronDown, IconPlus, IconTrash } from "@tabler/icons-preact";
import type { ConnectionEntry } from "../../types.ts";
import { api } from "../../api.ts";
import { shellAvailable, shellCall, type ShellState } from "../../shell.ts";
import { errorText } from "../../providers.ts";
import {
  connectionLabel,
  isSupportedUrl,
  notifyConnectionsUpdated,
  pageUrl,
  serverLabel,
  withUrl,
} from "../../connections.ts";
import { Field } from "../Field.tsx";
import { useT } from "../../i18n.ts";
import { confirmAction } from "../../confirm.ts";

const ACTIVE_TAG: CSSProperties = {
  fontSize: 11,
  padding: "2px 8px",
  borderRadius: "var(--radius-pill)",
  background: "var(--accent-soft)",
  color: "var(--text-dim)",
  marginLeft: 8,
};

/** Settings → 接続先サーバー. This list is the federation peer registry:
 * it lives in THIS server's database and is shared by web and desktop
 * clients alike. The desktop shell bridge only handles the local server
 * and UI switching; everything else goes through the same API.
 *
 * Each entry is a collapsed row (its name, the address, and the actions that
 * switch the window to it) that expands into the fields. Saving folds it
 * back: the fields are a form, and a form that stays open after it is
 * submitted reads as "nothing happened". A server just added opens expanded
 * — it has no name to show yet, so a collapsed row would be an empty one. */
export function ConnectionList() {
  const t = useT();
  /** null = probing the shell bridge. */
  const [desktop, setDesktop] = useState<boolean | null>(null);
  const [state, setState] = useState<ShellState | null>(null);
  const [servers, setServers] = useState<ConnectionEntry[]>([]);
  /** Ids whose fields are open. Everything else shows its summary row. */
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const ok = await shellAvailable();
      setDesktop(ok);
      if (ok) {
        shellCall<ShellState>("state").then(setState).catch(() => {});
      }
      await load();
    })();
  }, []);

  const load = async () => {
    setError(null);
    try {
      const { connections } = await api.getConnections();
      setServers(connections);
    } catch (e) {
      setError(errorText(e));
    }
  };

  /** Run an action; errors land in the top-level error line. */
  const run = async (fn: () => Promise<void>): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  /** Open or close one entry's fields. */
  const setExpandedId = (id: string, open: boolean) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (open) next.add(id);
      else next.delete(id);
      return next;
    });

  const connectLocal = () =>
    run(async () => {
      await shellCall("connect-local");
      // success navigates the whole app to the local server
    });

  const connect = (server: ConnectionEntry) =>
    run(async () => {
      const url = server.url.trim();
      if (!isSupportedUrl(url)) {
        throw new Error(t("settings.connection.badUrl"));
      }
      if (desktop) {
        // The shell switches the whole WebView, remembering the entry's
        // name: a remote page's registry is that server's own, so its
        // title bar cannot look this name up again.
        await shellCall("connect-remote", {
          url,
          token: server.token,
          name: connectionLabel(server),
        });
      } else {
        // Browser: navigating away IS the switch.
        location.href = pageUrl(url, server.token);
      }
    });

  const save = (server: ConnectionEntry) =>
    run(async () => {
      const next = servers.some((s) => s.id === server.id)
        ? servers.map((s) => (s.id === server.id ? server : s))
        : [...servers, server];
      await api.putConnections(next);
      setServers(next);
      // Saved: the fields fold back to the row they describe.
      setExpandedId(server.id, false);
      // The new/renamed entry must show up in the title bar's picker.
      notifyConnectionsUpdated();
    });

  const remove = (id: string) =>
    run(async () => {
      if (!confirmAction(t("settings.connection.deleteConfirm"))) return;
      const next = servers.filter((s) => s.id !== id);
      await api.putConnections(next);
      setServers(next);
      setExpandedId(id, false);
      notifyConnectionsUpdated();
    });

  const update = (id: string, patch: Partial<ConnectionEntry>) =>
    setServers((prev) =>
      prev.map((s) => (s.id === id ? { ...s, ...patch } : s))
    );

  /** Add an empty entry and open its fields: it has nothing to summarise. */
  const add = () => {
    const id = crypto.randomUUID();
    setServers((prev) => [...prev, { id, name: "", url: "", token: "" }]);
    setExpandedId(id, true);
  };

  /** Browser-mode reachability probe: no-cors resolves when the server
   * answers at all (token auth would answer 401), rejects on network
   * failure. The shell bridge's test does the full token check. */
  const probe = async (url: string) => {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      await fetch(`${url.replace(/\/+$/, "")}/api/health`, {
        mode: "no-cors",
        signal: controller.signal,
      });
      clearTimeout(timer);
      return {
        ok: true,
        text: t("settings.connection.testSuccess"),
      };
    } catch {
      return {
        ok: false,
        text: t("settings.connection.unreachable", { url }),
      };
    }
  };

  /** Full token check through the shell bridge (desktop only). */
  const bridgeTest = async (url: string, token: string) => {
    try {
      await shellCall("test", { url, token });
      return { ok: true, text: t("settings.connection.testOk") };
    } catch (e) {
      return {
        ok: false,
        text: errorText(e),
      };
    }
  };

  return (
    <>
      <div className="modal-header">
        <h2>{t("settings.connection.title")}</h2>
      </div>

      {desktop === null && (
        <p className="settings-note">{t("common.loading")}</p>
      )}
      {desktop !== null && (
        <div className="stack-8">
          <p className="settings-note">
            {desktop
              ? state?.mode === "remote"
                ? `${t("settings.connection.currentDisplay")} ${
                  serverLabel(state.name, state.url)
                }`
                : `${t("settings.connection.currentDisplay")} ${
                  t("settings.connection.localServer")
                }`
              : `${t("settings.connection.currentDisplay")} ${
                t("settings.connection.thisServer", {
                  origin: location.origin,
                })
              }`}
          </p>

          {error && <p className="error-text">{error}</p>}

          {desktop && (
            <div className="setting-card">
              <div style={{ flex: 1 }}>
                <span style={{ fontWeight: 600 }}>
                  {t("settings.connection.localServer")}
                  {state?.mode === "local" && (
                    <span style={ACTIVE_TAG}>
                      {t("settings.connection.activeTag")}
                    </span>
                  )}
                </span>
                <p className="settings-note">
                  {t("settings.connection.localServerDesc")}
                </p>
              </div>
              <button
                type="button"
                className="btn primary"
                disabled={busy || state?.mode === "local"}
                onClick={connectLocal}
              >
                {t("settings.connection.view")}
              </button>
            </div>
          )}

          {servers.map((server) => (
            <ServerCard
              key={server.id}
              server={server}
              busy={busy}
              expanded={expanded.has(server.id)}
              onToggle={() =>
                setExpandedId(server.id, !expanded.has(server.id))}
              onProbe={desktop
                ? (url, token) => bridgeTest(url, token)
                : (url) => probe(url)}
              onChange={(patch) => update(server.id, patch)}
              onConnect={() => connect(server)}
              onSave={() => save(server)}
              onDelete={() => remove(server.id)}
            />
          ))}

          {desktop && (
            <p className="settings-note">
              {t("settings.connection.persistedNote")}
            </p>
          )}

          <p className="settings-note">{t("settings.connection.urlHint")}</p>

          <div>
            <button type="button" className="btn" disabled={busy} onClick={add}>
              <IconPlus size={14} /> {t("settings.connection.addServer")}
            </button>
          </div>
        </div>
      )}
    </>
  );
}

function ServerCard({
  server,
  busy,
  expanded,
  onToggle,
  onProbe,
  onChange,
  onConnect,
  onSave,
  onDelete,
}: {
  server: ConnectionEntry;
  busy: boolean;
  expanded: boolean;
  onToggle: () => void;
  onProbe: (
    url: string,
    token: string,
  ) => Promise<{ ok: boolean; text: string }>;
  onChange: (patch: Partial<ConnectionEntry>) => void;
  onConnect: () => void;
  onSave: () => void;
  onDelete: () => void;
}) {
  const t = useT();
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(
    null,
  );

  const test = async () => {
    const url = server.url.trim();
    if (!isSupportedUrl(url)) {
      setResult({ ok: false, text: t("settings.connection.badUrl") });
      return;
    }
    setResult(null);
    setTesting(true);
    try {
      setResult(await onProbe(url, server.token));
    } catch (e) {
      setResult({
        ok: false,
        text: errorText(e),
      });
    } finally {
      setTesting(false);
    }
  };

  const title = server.name.trim() !== "" || server.url.trim() !== ""
    ? connectionLabel(server)
    : t("settings.connection.unnamed");

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        padding: "10px 12px",
        background: "var(--surface-2)",
        borderRadius: "var(--radius)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <button
          type="button"
          className="btn setting-card-open"
          onClick={onToggle}
          aria-expanded={expanded}
          title={expanded
            ? t("settings.connection.foldEntry")
            : t("settings.connection.editEntry")}
        >
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ fontWeight: 600 }}>{title}</span>
            {server.url.trim() !== "" && server.name.trim() !== "" && (
              <span
                className="settings-note"
                style={{
                  display: "block",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                title={server.url}
              >
                {server.url.trim()}
              </span>
            )}
          </span>
          <span
            className={`setting-card-chevron${expanded ? " open" : ""}`}
          >
            <IconChevronDown size={14} />
          </span>
        </button>
        <button
          type="button"
          className="btn primary"
          disabled={busy || testing}
          onClick={onConnect}
        >
          {t("settings.connection.view")}
        </button>
      </div>

      {expanded && (
        <>
          <Field label={t("settings.connection.serverNameLabel")}>
            <input
              value={server.name}
              onChange={(e) => onChange({ name: e.currentTarget.value })}
              placeholder={t("settings.connection.serverNamePlaceholder")}
            />
          </Field>
          <Field label="URL">
            <input
              value={server.url}
              onChange={(e) => onChange(withUrl(server, e.currentTarget.value))}
              placeholder="https://host.tailnet.ts.net"
              spellcheck={false}
            />
          </Field>
          <Field label={t("settings.connection.tokenLabel")}>
            <input
              type="password"
              value={server.token}
              onChange={(e) => onChange({ token: e.currentTarget.value })}
            />
          </Field>
          {result && (
            <p
              className={result.ok ? undefined : "error-text"}
              style={result.ok
                ? { color: "var(--ok)", fontSize: 12.5 }
                : undefined}
            >
              {result.text}
            </p>
          )}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              className="btn"
              disabled={busy || testing}
              onClick={test}
            >
              {t("settings.connection.test")}
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={busy || testing || server.url.trim() === ""}
              onClick={onSave}
            >
              {t("common.save")}
            </button>
            <button
              type="button"
              className="btn danger"
              disabled={busy || testing}
              onClick={onDelete}
              title={t("common.delete")}
              aria-label={t("common.delete")}
            >
              <IconTrash size={14} />
            </button>
          </div>
        </>
      )}
    </div>
  );
}
