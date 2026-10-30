import { useState } from "preact/compat";
import type {
  WebSearchProviderId,
  WebSearchSettingsView,
  WebSearchTestView,
} from "../../types.ts";
import { api } from "../../api.ts";
import { useT } from "../../i18n.ts";
import { Field } from "../Field.tsx";
import { errorText } from "../../providers.ts";
import { BackHeader } from "../BackHeader.tsx";

/**
 * Add a search provider, or replace one's key.
 *
 * Adding goes pick → paste key → check → add. The check cannot be skipped:
 * a key that does not search would make every later `web_search` call fail,
 * and the agent would be blamed for it.
 *
 * Editing only takes a new key (a provider's identity is its id), and an
 * empty field keeps the stored one.
 */
export function WebSearchProviderDialog({
  view,
  editing,
  onDone,
  onCancel,
}: {
  /** The setting as loaded, for the list of providers still available. */
  view: WebSearchSettingsView | null;
  editing?: { id: string; name: string };
  onDone: (next: WebSearchSettingsView) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const available = view?.available ?? [];

  const [id, setId] = useState<WebSearchProviderId | "">(
    editing === undefined
      ? (available[0]?.id ?? "")
      : (editing.id as WebSearchProviderId),
  );
  const [apiKey, setApiKey] = useState("");
  /** The answer of the last check, once one ran for the current input. */
  const [checked, setChecked] = useState<WebSearchTestView | null>(null);
  const [busy, setBusy] = useState<"checking" | "saving" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selected = available.find((provider) => provider.id === id) ?? null;
  const adding = editing === undefined;
  const key = apiKey.trim();

  /** Any edit invalidates a previous check: it was about other input. */
  const changeKey = (value: string) => {
    setApiKey(value);
    setChecked(null);
    setError(null);
  };

  const check = async () => {
    if (id === "") return;
    setBusy("checking");
    setError(null);
    try {
      setChecked(await api.testWebSearchProvider({ id, apiKey: key }));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    if (id === "") return;
    setBusy("saving");
    setError(null);
    try {
      const next = editing === undefined
        ? await api.addWebSearchProvider({ id, apiKey: key })
        : await api.updateWebSearchProvider(id, { apiKey: key });
      onDone(next);
    } catch (e) {
      setError(errorText(e));
      setBusy(null);
    }
  };

  return (
    <>
      <BackHeader
        onBack={onCancel}
        title={t(
          adding
            ? "settings.webSearch.form.addTitle"
            : "settings.webSearch.form.editTitle",
        )}
      />

      <div className="stack-8">
        {adding && (
          <Field label={t("settings.webSearch.form.provider")}>
            <select
              value={id}
              onChange={(e) => {
                setId(e.currentTarget.value as WebSearchProviderId);
                setChecked(null);
                setError(null);
              }}
            >
              {available.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.name}
                </option>
              ))}
            </select>
            {selected !== null && (
              <p className="settings-note">
                {t(
                  selected.supportsFetch
                    ? "settings.webSearch.useFetchApi"
                    : "settings.webSearch.useFetchDirect",
                )}
              </p>
            )}
            {available.length === 0 && (
              <p className="settings-note">
                {t("settings.webSearch.form.noProviders")}
              </p>
            )}
          </Field>
        )}

        <Field label={t("settings.webSearch.form.apiKey")}>
          <input
            type="password"
            autoComplete="off"
            value={apiKey}
            placeholder={editing?.name ?? ""}
            onChange={(e) => changeKey(e.currentTarget.value)}
          />
          {!adding && (
            <p className="settings-note">
              {t("settings.webSearch.form.apiKeyKeep")}
            </p>
          )}
        </Field>

        {adding && (
          <>
            {checked === null && (
              <p className="settings-note">
                {t("settings.webSearch.form.needKey")}
              </p>
            )}
            {checked !== null && checked.ok && (
              <p className="settings-note">
                {t("settings.webSearch.form.checked", {
                  count: checked.results,
                })}
              </p>
            )}
            {checked !== null && !checked.ok && (
              <p className="error-text">
                {t("settings.webSearch.form.failed", {
                  detail: checked.detail ?? "",
                })}
              </p>
            )}
          </>
        )}

        {error !== null && (
          <p className="error-text">
            {t("settings.webSearch.form.saveFailed", { error })}
          </p>
        )}

        <div className="stack-4" style={{ flexDirection: "row", gap: 8 }}>
          {adding && (
            <button
              type="button"
              className="btn"
              disabled={busy !== null || id === "" || key.length === 0}
              onClick={() => void check()}
            >
              {t(
                busy === "checking"
                  ? "settings.webSearch.form.checking"
                  : "settings.webSearch.form.check",
              )}
            </button>
          )}
          <button
            type="button"
            className="btn primary"
            disabled={busy !== null || id === "" ||
              (adding && (checked === null || !checked.ok))}
            onClick={() => void save()}
          >
            {t(
              adding
                ? "settings.webSearch.add"
                : "settings.webSearch.form.save",
            )}
          </button>
        </div>
      </div>
    </>
  );
}
