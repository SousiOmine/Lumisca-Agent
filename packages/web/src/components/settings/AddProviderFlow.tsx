import { useMemo, useState } from "react";
import { IconArrowLeft } from "@tabler/icons-react";
import { filterByQuery, useProviders } from "../../providers.ts";

/** Settings → add provider: searchable list of every known provider. */
export function AddProviderFlow({
  onSelect,
  onBack,
}: {
  onSelect: (providerId: string) => void;
  onBack: () => void;
}) {
  const { providers } = useProviders();
  const [search, setSearch] = useState("");

  const visible = useMemo(
    () => filterByQuery(providers, search),
    [providers, search],
  );

  return (
    <>
      <div className="modal-header">
        <button type="button" className="btn" onClick={onBack}>
          <IconArrowLeft size={14} /> 戻る
        </button>
        <h2>プロバイダーを追加</h2>
      </div>
      <p className="settings-note">
        追加するプロバイダーを選択してください
      </p>
      <input
        placeholder="プロバイダーを検索..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
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
            該当するプロバイダーがありません
          </div>
        )}
      </div>
    </>
  );
}
