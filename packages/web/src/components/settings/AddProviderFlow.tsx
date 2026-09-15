import { useMemo, useState } from "preact/compat";
import { IconArrowLeft, IconPlugConnected } from "@tabler/icons-preact";
import { filterByQuery, useProviderModels } from "../../providers.ts";
import { useT } from "../../i18n.ts";

/** Settings → add provider: searchable list of every known provider, plus
 * an entry to add an arbitrary OpenAI-compatible provider by hand. */
export function AddProviderFlow({
  onSelect,
  onAddUser,
  onBack,
}: {
  onSelect: (providerId: string) => void;
  onAddUser: () => void;
  onBack: () => void;
}) {
  const t = useT();
  const { providers } = useProviderModels("");
  const [search, setSearch] = useState("");

  const visible = useMemo(
    () => filterByQuery(providers, search),
    [providers, search],
  );

  return (
    <>
      <div className="modal-header">
        <button type="button" className="btn" onClick={onBack}>
          <IconArrowLeft size={14} /> {t("common.back")}
        </button>
        <h2>{t("settings.provider.addProvider")}</h2>
      </div>
      <p className="settings-note">
        {t("settings.provider.selectToAdd")}
      </p>
      <input
        placeholder={t("settings.provider.searchPlaceholder")}
        value={search}
        onChange={(e) => setSearch(e.currentTarget.value)}
      />
      <div className="model-list" style={{ maxHeight: 360 }}>
        {visible.map((p) => (
          <div
            key={p.id}
            className="model-item"
            onClick={() => onSelect(p.id)}
          >
            <span className="model-id">{p.name}</span>
            <span className="model-meta">{p.id}</span>
          </div>
        ))}
        {visible.length === 0 && (
          <div className="faint-box">
            {t("settings.provider.noMatch")}
          </div>
        )}
      </div>

      <p className="settings-note" style={{ marginTop: 12 }}>
        {t("settings.provider.notInList")}
      </p>
      <button type="button" className="btn" onClick={onAddUser}>
        <IconPlugConnected size={14} />
        {t("settings.provider.addCustomOpenAI")}
      </button>
    </>
  );
}
