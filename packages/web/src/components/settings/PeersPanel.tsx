import { errorMessage } from "@lumisca/core/shared";
import { IconChevronDown, IconPlus, IconTrash } from "@tabler/icons-preact";
import { useEffect, useState } from "preact/hooks";
import { api } from "../../api.ts";
import { confirmAction } from "../../confirm.ts";
import { connectionLabel, isSupportedUrl, withUrl } from "../../connections.ts";
import { useT } from "../../i18n.ts";
import type { ConnectionEntry } from "../../types.ts";
import { Field } from "../Field.tsx";

/** Settings → 連携先サーバー, on the server's side.
 *
 * These are the servers THIS server federates with: it authenticates to
 * each one, proxies its sessions into this server's list, and relays its
 * events. The list is stored in this server's database and is shared by
 * every client of this server.
 *
 * It is not the window's list. Which servers the desktop window can display
 * is the device's own question (ConnectionsPanel, stored in the shell), and
 * conflating the two was the bug: a server's peer list changed with the
 * display, and the page could switch the window to a machine the server
 * merely federated with. */
export function PeersPanel() {
  const t = useT();
  const [entries, setEntries] = useState<readonly ConnectionEntry[] | null>(
    null,
  );
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stale = false;
    api
      .getConnections()
      .then(({ connections }) => {
        if (!stale) setEntries(connections);
      })
      .catch((e: unknown) => {
        if (!stale) setError(errorMessage(e));
      });
    return () => {
      stale = true;
    };
  }, []);

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

  const update = (id: string, patch: Partial<ConnectionEntry>) =>
    setEntries((prev) =>
      (prev ?? []).map((entry) =>
        entry.id === id ? { ...entry, ...patch } : entry,
      ),
    );

  const save = (entry: ConnectionEntry) =>
    run(async () => {
      if (!isSupportedUrl(entry.url.trim())) {
        throw new Error(t("settings.connection.badUrl"));
      }
      const next = (entries ?? []).some(
        (candidate) => candidate.id === entry.id,
      )
        ? (entries ?? []).map((candidate) =>
            candidate.id === entry.id ? entry : candidate,
          )
        : [...(entries ?? []), entry];
      await api.putConnections([...next]);
      setEntries(next);
      setExpandedId(entry.id, false);
    });

  const remove = (id: string) =>
    run(async () => {
      if (!confirmAction(t("settings.connection.deleteConfirm"))) return;
      const next = (entries ?? []).filter((entry) => entry.id !== id);
      await api.putConnections([...next]);
      setEntries(next);
      setExpandedId(id, false);
    });

  const add = () => {
    const id = crypto.randomUUID();
    setEntries((prev) => [
      ...(prev ?? []),
      { id, name: "", url: "", token: "" },
    ]);
    setExpandedId(id, true);
  };

  if (entries === null) {
    return error === null ? (
      <p className="settings-note">{t("common.loading")}</p>
    ) : (
      <p className="error-text">{error}</p>
    );
  }

  return (
    <div className="stack-8">
      <p className="settings-note">{t("settings.peers.note")}</p>
      {error !== null && <p className="error-text">{error}</p>}

      {entries.length === 0 && (
        <p className="settings-note">{t("settings.peers.empty")}</p>
      )}

      {entries.map((entry) => (
        <PeerCard
          key={entry.id}
          entry={entry}
          busy={busy}
          expanded={expanded.has(entry.id)}
          onToggle={() => setExpandedId(entry.id, !expanded.has(entry.id))}
          onChange={(patch) => update(entry.id, patch)}
          onSave={() => save(entry)}
          onDelete={() => remove(entry.id)}
        />
      ))}

      <div>
        <button type="button" className="btn" disabled={busy} onClick={add}>
          <IconPlus size={14} /> {t("settings.peers.add")}
        </button>
      </div>
    </div>
  );
}

function PeerCard({
  entry,
  busy,
  expanded,
  onToggle,
  onChange,
  onSave,
  onDelete,
}: {
  entry: ConnectionEntry;
  busy: boolean;
  expanded: boolean;
  onToggle: () => void;
  onChange: (patch: Partial<ConnectionEntry>) => void;
  onSave: () => void;
  onDelete: () => void;
}) {
  const t = useT();
  const title =
    entry.name.trim() !== "" || entry.url.trim() !== ""
      ? connectionLabel(entry)
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
            {entry.url.trim() !== "" && entry.name.trim() !== "" && (
              <span
                className="settings-note"
                style={{
                  display: "block",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                title={entry.url}
              >
                {entry.url.trim()}
              </span>
            )}
          </span>
          <span className={`setting-card-chevron${expanded ? " open" : ""}`}>
            <IconChevronDown size={14} />
          </span>
        </button>
      </div>

      {expanded && (
        <>
          <Field label={t("settings.connection.serverNameLabel")}>
            <input
              value={entry.name}
              onChange={(e) => onChange({ name: e.currentTarget.value })}
              placeholder={t("settings.connection.serverNamePlaceholder")}
            />
          </Field>
          <Field label={t("settings.connection.urlLabel")}>
            <input
              value={entry.url}
              onChange={(e) => onChange(withUrl(entry, e.currentTarget.value))}
              placeholder="https://host.tailnet.ts.net"
              spellcheck={false}
            />
          </Field>
          <Field label={t("settings.connection.tokenLabel")}>
            <input
              type="password"
              value={entry.token}
              onChange={(e) => onChange({ token: e.currentTarget.value })}
            />
          </Field>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              className="btn primary"
              disabled={busy || entry.url.trim() === ""}
              onClick={onSave}
            >
              {t("common.save")}
            </button>
            <button
              type="button"
              className="btn danger"
              disabled={busy}
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
