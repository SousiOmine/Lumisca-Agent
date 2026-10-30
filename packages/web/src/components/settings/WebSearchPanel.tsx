import { useEffect, useState } from "preact/compat";
import { IconPlus, IconTrash } from "@tabler/icons-preact";
import type { WebSearchSettingsView } from "../../types.ts";
import { api } from "../../api.ts";
import { errorText } from "../../providers.ts";
import { useT } from "../../i18n.ts";
import { WebSearchProviderDialog } from "./WebSearchProviderDialog.tsx";

/** Which provider the dialog is editing: adding one, or changing a stored
 * key. */
type DialogMode =
  | { kind: "add" }
  | { kind: "edit"; id: string; name: string };

/**
 * Settings → web search.
 *
 * The agent searches with exactly one provider (the default). Adding one
 * checks the key first: a stored key that cannot search would make every
 * `web_search` call fail, and the failure would look like the agent's fault.
 *
 * Each mutation answers with the whole setting, so the panel replaces what it
 * shows instead of patching it.
 */
export function WebSearchPanel() {
  const t = useT();
  const [view, setView] = useState<WebSearchSettingsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogMode | null>(null);
  /** The provider whose default is being switched (one at a time). */
  const [busy, setBusy] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      setView(await api.getWebSearchSettings());
      setError(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  /** Run one mutation and adopt its answer as the new state. */
  const mutate = async (
    id: string | null,
    run: () => Promise<WebSearchSettingsView>,
  ): Promise<boolean> => {
    setBusy(id);
    try {
      setView(await run());
      setError(null);
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const remove = async (id: string, name: string) => {
    if (!globalThis.confirm(t("settings.webSearch.removeConfirm", { name }))) {
      return;
    }
    await mutate(id, () => api.deleteWebSearchProvider(id));
  };

  if (dialog !== null) {
    return (
      <WebSearchProviderDialog
        view={view}
        editing={dialog.kind === "edit" ? dialog : undefined}
        onDone={(next) => {
          setView(next);
          setDialog(null);
        }}
        onCancel={() => setDialog(null)}
      />
    );
  }

  return (
    <div className="settings-pane">
      <div className="modal-header">
        <h2>{t("settings.webSearch.title")}</h2>
        <button
          type="button"
          className="btn push"
          disabled={loading || (view?.available.length ?? 0) === 0}
          onClick={() => setDialog({ kind: "add" })}
        >
          <IconPlus size={14} />
          {t("settings.webSearch.add")}
        </button>
      </div>

      <p className="settings-note">{t("settings.webSearch.description")}</p>

      {error !== null && (
        <p className="error-text">
          {t("settings.webSearch.loadFailed", { error })}
        </p>
      )}

      {loading && <p className="settings-note">{t("common.loading")}</p>}

      {!loading && view !== null && view.providers.length === 0 && (
        <div className="faint-box">{t("settings.webSearch.empty")}</div>
      )}

      {!loading && view !== null && view.providers.length > 0 &&
        view.defaultId === null && (
        <p className="settings-note">{t("settings.webSearch.noDefault")}</p>
      )}

      {!loading &&
        view?.providers.map((provider) => (
          <div key={provider.id} className="setting-card">
            <div className="setting-card-open" style={{ cursor: "default" }}>
              <span style={{ flex: 1 }}>
                {provider.name}
                {provider.isDefault && (
                  <span
                    className="provider-state configured"
                    style={{ marginLeft: 8 }}
                  >
                    {t("settings.webSearch.defaultBadge")}
                  </span>
                )}
                <span className="settings-note" style={{ display: "block" }}>
                  {[
                    t(
                      provider.supportsFetch
                        ? "settings.webSearch.useFetchApi"
                        : "settings.webSearch.useFetchDirect",
                    ),
                    t(
                      provider.hasApiKey
                        ? "settings.webSearch.keySet"
                        : "settings.webSearch.keyUnset",
                    ),
                  ].join(" / ")}
                </span>
              </span>
              {!provider.isDefault && (
                <button
                  type="button"
                  className="btn"
                  disabled={busy !== null}
                  onClick={() =>
                    void mutate(
                      provider.id,
                      () => api.setDefaultWebSearchProvider(provider.id),
                    )}
                >
                  {t("settings.webSearch.makeDefault")}
                </button>
              )}
              <button
                type="button"
                className="btn"
                disabled={busy !== null}
                onClick={() =>
                  setDialog({
                    kind: "edit",
                    id: provider.id,
                    name: provider.name,
                  })}
              >
                {t("common.edit")}
              </button>
              <button
                type="button"
                className="btn"
                disabled={busy !== null}
                title={t("settings.webSearch.remove")}
                aria-label={t("settings.webSearch.remove")}
                onClick={() =>
                  void remove(provider.id, provider.name)}
              >
                <IconTrash size={14} />
              </button>
            </div>
          </div>
        ))}
    </div>
  );
}
