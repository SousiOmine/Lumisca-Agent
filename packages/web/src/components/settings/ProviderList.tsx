import { useState } from "preact/compat";
import { IconPlus } from "@tabler/icons-preact";
import { api } from "../../api.ts";
import { useAsyncEffect } from "../../hooks/useAsync.ts";
import { useT } from "../../i18n.ts";
import { errorText, useProviderModels } from "../../providers.ts";
import type { CatalogStatus } from "../../types.ts";

/** One-line catalog status with a manual refresh button. Shown at the top
 * of the provider list: the model catalog now syncs from models.dev at
 * startup (and on demand here), falling back to the cache/bundled
 * snapshot when offline. */
function CatalogStatusRow({ onRefreshed }: { onRefreshed: () => void }) {
  const t = useT();
  const [status, setStatus] = useState<CatalogStatus | undefined>();
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useAsyncEffect(async (isStale) => {
    try {
      const { status } = await api.catalogStatus();
      if (!isStale()) setStatus(status);
    } catch {
      // Status is informational only; the provider list works without it.
    }
  }, []);

  const refresh = async () => {
    setRefreshing(true);
    setError(undefined);
    try {
      const { status } = await api.refreshCatalog();
      setStatus(status);
      if (status.error) setError(status.error);
      onRefreshed();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setRefreshing(false);
    }
  };

  const sourceLabel = status?.source === "live"
    ? t("settings.provider.catalogSourceLatest")
    : status?.source === "cache"
    ? t("settings.provider.catalogSourceCache")
    : t("settings.provider.catalogSourceSnapshot");

  const generated = status?.generatedAt !== undefined
    ? ` (${status.generatedAt.slice(0, 10)})`
    : "";
  return (
    <div className="faint-box">
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <span style={{ flex: 1 }}>
          {t("settings.provider.catalogStatus")} {status
            ? `${sourceLabel}${generated}`
            : t("settings.provider.catalogChecking")}
        </span>
        <button
          type="button"
          className="btn small"
          onClick={refresh}
          disabled={refreshing}
        >
          {refreshing
            ? t("settings.provider.refreshing")
            : t("settings.provider.refreshToLatest")}
        </button>
      </div>
      {error && (
        <p className="settings-note" style={{ marginTop: 6 }}>
          {t("settings.provider.refreshFailed", { error })}
        </p>
      )}
    </div>
  );
}

/** Settings → provider list: configured first, then everything else.
 * User-defined providers are shown even when not yet configured, so they
 * stay reachable (to add a key, edit, or delete). */
export function ProviderList({
  onAdd,
  onOpen,
}: {
  onAdd: () => void;
  onOpen: (providerId: string) => void;
}) {
  const t = useT();
  const { providers, reload } = useProviderModels("");

  const configured = providers.filter(
    (p) => p.configured !== false || p.userDefined,
  );

  return (
    <>
      <div className="modal-header">
        <h2>{t("settings.nav.providers")}</h2>
      </div>

      <CatalogStatusRow onRefreshed={reload} />

      <div className="stack-8">
        {configured.length === 0 && (
          <div className="faint-box">
            {t("settings.provider.noProviders")}
          </div>
        )}
        {configured.map((p) => (
          <button
            type="button"
            key={p.id}
            className="btn"
            style={{
              textAlign: "left",
              display: "flex",
              alignItems: "center",
              gap: 10,
            }}
            onClick={() => onOpen(p.id)}
          >
            <span style={{ flex: 1 }}>{p.name}</span>
            {p.userDefined
              ? (
                <span className="provider-state">
                  {p.configured
                    ? t("settings.provider.configured")
                    : t("settings.provider.notConfigured")}
                </span>
              )
              : (
                <span className="provider-state configured">
                  {p.authType === "oauth"
                    ? "OAuth"
                    : (p.source ?? t("settings.provider.apiKeyLabel"))}
                </span>
              )}
          </button>
        ))}
      </div>

      <div className="modal-actions">
        <button type="button" className="btn primary" onClick={onAdd}>
          <IconPlus size={14} />
          {t("settings.provider.addProvider")}
        </button>
      </div>
    </>
  );
}
