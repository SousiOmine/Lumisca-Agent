import { useMemo, useState } from "react";
import { IconArrowLeft, IconPlugConnected } from "@tabler/icons-react";
import { filterByQuery, useProviders } from "../../providers.ts";

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

      <p className="settings-note" style={{ marginTop: 12 }}>
        一覧にないプロバイダー
      </p>
      <button type="button" className="btn" onClick={onAddUser}>
        <IconPlugConnected size={14} />
        カスタム OpenAI 互換プロバイダーを追加
      </button>
    </>
  );
}
