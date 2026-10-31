import { useState } from "preact/compat";
import { IconPlus } from "@tabler/icons-preact";
import { api } from "../../api.ts";
import { useAsyncEffect } from "../../hooks/useAsync.ts";
import { useT } from "../../i18n.ts";
import { errorText, useProviderModels } from "../../providers.ts";
import type { CatalogStatus } from "../../types.ts";
import { SettingsSection } from "./SettingsSection.tsx";
import { ProviderRow } from "./ProviderRow.tsx";

/** One-line catalog status with a manual refresh button. Shown under the AI
 * provider list: the model catalog syncs from models.dev at startup and on
 * demand here, and reports which copy it is showing (live, cache, bundled
 * snapshot). */
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
    <div className="catalog-status">
      <span className="settings-note">
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
      {error && (
        <p className="settings-note">
          {t("settings.provider.refreshFailed", { error })}
        </p>
      )}
    </div>
  );
}

/** Settings → プロバイダー: the AI providers, the first of the category's two
 * sections (the web-search providers follow in `WebSearchPanel`).
 * User-defined providers are shown even when not yet configured, so they
 * stay reachable (to add a key, edit, or delete).
 *
 * Both sections share one shape (`SettingsSection` + `ProviderRow`): the
 * heading with its add button, a one-line explanation, then the services. */
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
    <SettingsSection
      title={t("settings.provider.aiTitle")}
      description={t("settings.provider.aiDescription")}
      action={
        <button type="button" className="btn" onClick={onAdd}>
          <IconPlus size={14} />
          {t("settings.provider.addProvider")}
        </button>
      }
    >
      {configured.length === 0 && (
        <p className="settings-note">{t("settings.provider.noProviders")}</p>
      )}
      {configured.map((p) => (
        <ProviderRow
          key={p.id}
          name={p.name}
          status={p.userDefined
            ? (p.configured
              ? t("settings.provider.configured")
              : t("settings.provider.notConfigured"))
            : (p.authType === "oauth"
              ? t("settings.provider.oauth")
              : (p.source ?? t("settings.provider.apiKeyLabel")))}
          onOpen={() => onOpen(p.id)}
        />
      ))}
      <CatalogStatusRow onRefreshed={reload} />
    </SettingsSection>
  );
}
