import { IconRefresh } from "@tabler/icons-preact";
import type { RecentSessionItem } from "../hooks/useRecentSessions.ts";
import { formatRelativeTime } from "../format.ts";
import { useLocale, useT } from "../i18n.ts";

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

/** The closed-session list shared by the "セッション履歴" modal and the
 * "最近使ったセッション" section of the new-session screen. Clicking a row
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
  const t = useT();
  const locale = useLocale();
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
            title={t("common.reload")}
          >
            <IconRefresh size={13} />
            {t("common.reload")}
          </button>
        )}
      </div>
    );
  }

  if (loading && items.length === 0) {
    return <div className="recent-empty">{t("common.loading")}</div>;
  }

  if (visible.length === 0) {
    return <div className="recent-empty">{t("panels.recent.empty")}</div>;
  }

  return (
    <div className={bare ? "recent-list bare" : "recent-list"}>
      {visible.map(({ key, info, peerId, peerName }) => {
        const name = info.name || t("panels.recent.untitled");
        return (
          <button
            key={key}
            type="button"
            className="recent-item"
            onClick={() => onSelect(key)}
            title={t("panels.recent.openTab", { name })}
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
              {formatRelativeTime(info.updatedAt, locale)}
            </span>
          </button>
        );
      })}
    </div>
  );
}
