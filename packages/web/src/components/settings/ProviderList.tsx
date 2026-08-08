import { IconPlus } from "@tabler/icons-react";
import { useProviders } from "../../providers.ts";

/** Settings → provider list: configured first, then everything else. */
export function ProviderList({
  onAdd,
  onOpen,
}: {
  onAdd: () => void;
  onOpen: (providerId: string) => void;
}) {
  const { providers } = useProviders();

  const configured = providers.filter((p) => p.configured !== false);
  const others = providers.filter((p) => p.configured === false);

  return (
    <>
      <div className="modal-header">
        <h2>プロバイダー</h2>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <p className="settings-note">
          設定済みプロバイダー
        </p>
        {configured.length === 0 && (
          <div className="faint-box">
            まだありません。下の「プロバイダーを追加」から始めてください。
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
            <span className="provider-state configured">
              {p.source ?? "APIキー"}
            </span>
          </button>
        ))}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <p className="settings-note">
          未設定のプロバイダー
        </p>
        {others.slice(0, 12).map((p) => (
          <button
            type="button"
            key={p.id}
            className="btn"
            style={{ textAlign: "left" }}
            onClick={() => onOpen(p.id)}
          >
            {p.name}
          </button>
        ))}
        {others.length > 12 && (
          <p className="settings-note">
            …ほか {others.length - 12} 件(プロバイダーを追加から選択できます)
          </p>
        )}
      </div>

      <div className="modal-actions">
        <button type="button" className="btn primary" onClick={onAdd}>
          <IconPlus size={14} />
          プロバイダーを追加
        </button>
      </div>
    </>
  );
}
