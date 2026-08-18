import { IconRefresh } from "@tabler/icons-react";
import type { RecentSessionItem } from "../hooks/useRecentSessions.ts";

interface RecentSessionsListProps {
  items: RecentSessionItem[];
  loading: boolean;
  error?: string;
  /** Tab keys currently open; those sessions are omitted (the list is for
   * closed sessions). */
  openKeys: ReadonlySet<string>;
  /** Cap the visible rows (the new-session screen shows a short list). */
  limit?: number;
  /** Render as a plain list of rows without the boxed container (the
   * new-session screen), instead of the bordered panel (the modal). */
  bare?: boolean;
  onSelect: (key: string) => void;
  onReload?: () => void;
}

/** Japanese relative time, falling back to a date for older sessions. */
function relativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  if (diff < 60_000) return "たった今";
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes}分前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}時間前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}日前`;
  const d = new Date(timestamp);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

/** The closed-session list shared by the "過去のセッション" modal and the
 * "最近のセッション" section of the new-session screen. Clicking a row
 * reopens that session in a tab. */
export function RecentSessionsList({
  items,
  loading,
  error,
  openKeys,
  limit,
  bare,
  onSelect,
  onReload,
}: RecentSessionsListProps) {
  const visible = items.filter((item) => !openKeys.has(item.key)).slice(
    0,
    limit,
  );

  if (error) {
    return (
      <div className="recent-error">
        <span className="error-text">{error}</span>
        {onReload && (
          <button
            type="button"
            className="btn small"
            onClick={onReload}
            title="再読み込み"
          >
            <IconRefresh size={13} />
            再読み込み
          </button>
        )}
      </div>
    );
  }

  if (loading && items.length === 0) {
    return <div className="recent-empty">読み込み中...</div>;
  }

  if (visible.length === 0) {
    return <div className="recent-empty">最近のセッションはありません</div>;
  }

  return (
    <div className={bare ? "recent-list bare" : "recent-list"}>
      {visible.map(({ key, info, peerId, peerName }) => {
        const name = info.name || "無題のセッション";
        return (
          <button
            key={key}
            type="button"
            className="recent-item"
            onClick={() => onSelect(key)}
            title={`${name} をタブで開く`}
          >
            <span className="recent-item-body">
              <span className="recent-item-name">{name}</span>
              {peerId !== "" && (
                <span className="recent-item-meta">
                  <span className="recent-item-peer">
                    {peerName || peerId}
                  </span>
                </span>
              )}
            </span>
            <span className="recent-item-time">
              {relativeTime(info.updatedAt)}
            </span>
          </button>
        );
      })}
    </div>
  );
}
