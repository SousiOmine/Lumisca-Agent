import { useEffect, useState } from "preact/compat";
import { IconPlus, IconTrash } from "@tabler/icons-preact";
import type { WebSearchSettingsView } from "../../types.ts";
import { api } from "../../api.ts";
import { errorText } from "../../providers.ts";
import { useT } from "../../i18n.ts";
import { WebSearchProviderDialog } from "./WebSearchProviderDialog.tsx";
import { confirmAction } from "../../confirm.ts";
import { SettingsSection } from "./SettingsSection.tsx";
import { ProviderRow } from "./ProviderRow.tsx";

/** Which provider the dialog is editing: adding one, or changing a stored
 * key. */
type DialogMode =
  | { kind: "add" }
  | { kind: "edit"; id: string; name: string };

/**
 * Settings → プロバイダー → Web 検索: the search provider the agent's
 * `web_search` tool uses.
 *
 * It is the category's second section rather than a category of its own:
 * both lists answer "which service does this installation hold a key for",
 * and a separate entry made the search side easy to miss. It is also the
 * same shape as the AI list — heading with its add button, a one-line
 * explanation, then one row per service — so the two sections read as one
 * list of services rather than two screens that happen to share a page.
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
    if (!confirmAction(t("settings.webSearch.removeConfirm", { name }))) {
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

  const canAdd = !loading && (view?.available.length ?? 0) > 0;

  return (
    <SettingsSection
      title={t("settings.webSearch.title")}
      description={t("settings.webSearch.description")}
      action={
        <button
          type="button"
          className="btn"
          disabled={!canAdd}
          onClick={() => setDialog({ kind: "add" })}
        >
          <IconPlus size={14} />
          {t("settings.webSearch.add")}
        </button>
      }
    >
      {error !== null && (
        <p className="error-text">
          {t("settings.webSearch.loadFailed", { error })}
        </p>
      )}

      {loading && <p className="settings-note">{t("common.loading")}</p>}

      {!loading && view !== null && view.providers.length === 0 && (
        <p className="settings-note">{t("settings.webSearch.empty")}</p>
      )}

      {!loading && view !== null && view.providers.length > 0 &&
        view.defaultId === null && (
        <p className="settings-note">{t("settings.webSearch.noDefault")}</p>
      )}

      {!loading &&
        view?.providers.map((provider) => (
          <ProviderRow
            key={provider.id}
            name={provider.name}
            status={
              <>
                {provider.isDefault && (
                  <span className="provider-row-badge">
                    {t("settings.webSearch.defaultBadge")}
                  </span>
                )}
                {t(
                  provider.hasApiKey
                    ? "settings.webSearch.keySet"
                    : "settings.webSearch.keyUnset",
                )}
              </>
            }
            trailing={
              <>
                {!provider.isDefault && (
                  <button
                    type="button"
                    className="btn small"
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
                  className="btn small"
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
                  className="btn small"
                  disabled={busy !== null}
                  title={t("settings.webSearch.remove")}
                  aria-label={t("settings.webSearch.remove")}
                  onClick={() => void remove(provider.id, provider.name)}
                >
                  <IconTrash size={14} />
                </button>
              </>
            }
          />
        ))}
    </SettingsSection>
  );
}
