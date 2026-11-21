import { errorMessage } from "@lumisca/core/shared";
import { IconChevronDown, IconPlus, IconTrash } from "@tabler/icons-preact";
import { useState } from "preact/hooks";
import { confirmAction } from "../../confirm.ts";
import {
  connectionLabel,
  deleteConnection,
  isSupportedUrl,
  saveConnection,
  useConnections,
  withUrl,
} from "../../connections.ts";
import { useConnectionSwitch } from "../../hooks/useConnectionSwitch.ts";
import { useT } from "../../i18n.ts";
import { shellCall } from "../../shell.ts";
import type { ConnectionEntry } from "../../types.ts";
import { Field } from "../Field.tsx";

/** Settings → 接続先サーバー, on the device's side.
 *
 * This list belongs to the window: it is stored in the shell's settings and
 * restored on the next launch, and it is the same list whichever server the
 * page is served by. A list kept on the server would change with the
 * display, which is the bug this page exists to prevent. The browser has no
 * such list — the address bar is the way to another server there — so the
 * page is desktop-only.
 *
 * Each entry is a collapsed row (its name, the address, and the action that
 * switches the window to it) that expands into the fields. Saving folds it
 * back: the fields are a form, and a form that stays open after it is
 * submitted reads as "nothing happened". A server just added opens expanded
 * — it has no name to show yet, so a collapsed row would be an empty one. */
export function ConnectionsPanel() {
  const t = useT();
  const connection = useConnectionSwitch();
  const { entries: stored, loaded, error: loadError } = useConnections();
  // A row's fields are local until Save; an added-but-never-saved row must
  // not appear in the picker. Save writes the row through the bridge, so
  // both surfaces see the result at once.
  const [draft, setDraft] = useState<readonly ConnectionEntry[] | null>(null);
  const servers = draft ?? stored;
  /** Ids whose fields are open. Everything else shows its summary row. */
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setServers = (
    update: (current: readonly ConnectionEntry[]) => readonly ConnectionEntry[],
  ) => setDraft(update(draft ?? stored));

  const run = async (fn: () => Promise<void>): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const setExpandedId = (id: string, open: boolean) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (open) next.add(id);
      else next.delete(id);
      return next;
    });

  const connectLocal = () =>
    run(async () => {
      await connection.connect("local");
    });

  const connect = (server: ConnectionEntry) =>
    run(async () => {
      if (!isSupportedUrl(server.url.trim())) {
        throw new Error(t("settings.connection.badUrl"));
      }
      await connection.connect(server);
    });

  const save = (server: ConnectionEntry) =>
    run(async () => {
      if (!isSupportedUrl(server.url.trim())) {
        throw new Error(t("settings.connection.badUrl"));
      }
      await saveConnection(server);
      // Saved: the store now holds this list, so the panel edits it again
      // instead of a draft of it, and the fields fold back to the row they
      // describe.
      setDraft(null);
      setExpandedId(server.id, false);
    });

  const remove = (id: string) =>
    run(async () => {
      if (!confirmAction(t("settings.connection.deleteConfirm"))) return;
      await deleteConnection(id);
      setDraft(null);
      setExpandedId(id, false);
    });

  const update = (id: string, patch: Partial<ConnectionEntry>) =>
    setServers((prev) =>
      prev.map((s) => (s.id === id ? { ...s, ...patch } : s)),
    );

  /** Add an empty entry and open its fields: it has nothing to summarise. */
  const add = () => {
    const id = crypto.randomUUID();
    setServers((prev) => [...prev, { id, name: "", url: "", token: "" }]);
    setExpandedId(id, true);
  };

  /** Full token check through the shell bridge. The token is what the
   * health probe needs; a no-cors probe would only prove the port answers. */
  const probe = async (url: string, token: string) => {
    try {
      await shellCall("test", { url, token });
      return { ok: true, text: t("settings.connection.testOk") };
    } catch (e) {
      return { ok: false, text: errorMessage(e) };
    }
  };

  if (!loaded) {
    return <p className="settings-note">{t("common.loading")}</p>;
  }

  return (
    <div className="stack-8">
      <p className="settings-note">{t("settings.connection.deviceNote")}</p>
      <p className="settings-note">
        {t("settings.connection.currentDisplay")}{" "}
        {connection.state?.mode === "local"
          ? t("settings.connection.localServer")
          : connection.currentLabel()}
      </p>

      {(error ?? loadError) !== null && (
        <p className="error-text">{error ?? loadError}</p>
      )}

      <div className="setting-card">
        <div style={{ flex: 1 }}>
          <span style={{ fontWeight: 600 }}>
            {t("settings.connection.localServer")}
            {connection.state?.mode === "local" && (
              <span className="connection-active">
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
          disabled={
            busy ||
            connection.busy !== null ||
            connection.state?.mode === "local"
          }
          onClick={connectLocal}
        >
          {t("settings.connection.view")}
        </button>
      </div>

      {servers.map((server) => (
        <ServerCard
          key={server.id}
          server={server}
          busy={busy || connection.busy !== null}
          current={connection.currentId === server.id}
          expanded={expanded.has(server.id)}
          onToggle={() => setExpandedId(server.id, !expanded.has(server.id))}
          onProbe={probe}
          onChange={(patch) => update(server.id, patch)}
          onConnect={() => connect(server)}
          onSave={() => save(server)}
          onDelete={() => remove(server.id)}
        />
      ))}

      <p className="settings-note">{t("settings.connection.persistedNote")}</p>
      <p className="settings-note">{t("settings.connection.urlHint")}</p>

      <div>
        <button type="button" className="btn" disabled={busy} onClick={add}>
          <IconPlus size={14} /> {t("common.addServer")}
        </button>
      </div>
    </div>
  );
}

function ServerCard({
  server,
  busy,
  current,
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
  current: boolean;
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
      setResult({ ok: false, text: errorMessage(e) });
    } finally {
      setTesting(false);
    }
  };

  const title =
    server.name.trim() !== "" || server.url.trim() !== ""
      ? connectionLabel(server)
      : t("settings.connection.unnamed");

  return (
    <div className="setting-card setting-card-stack">
      <div className="setting-card-row">
        <button
          type="button"
          className="btn setting-card-open"
          onClick={onToggle}
          aria-expanded={expanded}
          title={
            expanded
              ? t("settings.connection.foldEntry")
              : t("settings.connection.editEntry")
          }
        >
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ fontWeight: 600 }}>{title}</span>
            {current && (
              <span className="connection-active">
                {t("settings.connection.activeTag")}
              </span>
            )}
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
          <span className={`setting-card-chevron${expanded ? " open" : ""}`}>
            <IconChevronDown size={14} />
          </span>
        </button>
        <button
          type="button"
          className="btn primary setting-card-action"
          disabled={busy || testing || current}
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
          <Field label={t("settings.connection.urlLabel")}>
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
              style={
                result.ok ? { color: "var(--ok)", fontSize: 12.5 } : undefined
              }
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
              disabled={busy || testing || current}
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
