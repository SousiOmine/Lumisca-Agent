import {
  IconMoon,
  IconPlus,
  IconSettings,
  IconSun,
  IconX,
} from "@tabler/icons-react";
import { isViewRunning, type SessionView } from "../types.ts";

interface TabBarProps {
  tabs: string[];
  views: Map<string, SessionView>;
  activeTab: string | null;
  theme: "light" | "dark";
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  onToggleTheme: () => void;
  onOpenSettings: () => void;
}

export function TabBar({
  tabs,
  views,
  activeTab,
  theme,
  onSelect,
  onClose,
  onNew,
  onToggleTheme,
  onOpenSettings,
}: TabBarProps) {
  return (
    <div className="tabbar" role="tablist" aria-label="セッションタブ">
      <button
        type="button"
        className="tab-new"
        onClick={onNew}
        title="新しいセッション"
        aria-label="新しいセッション"
      >
        <IconPlus size={17} />
      </button>
      {tabs.map((id) => {
        const view = views.get(id);
        const isActive = id === activeTab;
        const isRunning = view !== undefined && isViewRunning(view);
        const runningTool = view?.runningTools.values().next().value as
          | string
          | undefined;
        const name = view?.info.name ?? "新規セッション";
        return (
          <div
            key={id}
            role="tab"
            aria-selected={isActive}
            className={`tab${isActive ? " active" : ""}`}
            onClick={() => onSelect(id)}
            title={view?.info.modelId ?? "新規セッション"}
          >
            {isRunning && <span className="live-dot" aria-label="実行中" />}
            <span className="tab-name">{name}</span>
            {isRunning && runningTool && (
              <span className="tab-badge">{runningTool}</span>
            )}
            <button
              type="button"
              className="tab-close"
              onClick={(e) => {
                e.stopPropagation();
                onClose(id);
              }}
              title="タブを閉じる"
              aria-label={`${name} を閉じる`}
            >
              <IconX size={13} />
            </button>
          </div>
        );
      })}
      <div className="tabbar-actions">
        <button
          type="button"
          className="icon-btn"
          onClick={onToggleTheme}
          title={theme === "dark"
            ? "ライトモードに切り替え"
            : "ダークモードに切り替え"}
        >
          {theme === "dark" ? <IconSun size={17} /> : <IconMoon size={17} />}
        </button>
        <button
          type="button"
          className="icon-btn"
          onClick={onOpenSettings}
          title="設定"
        >
          <IconSettings size={17} />
        </button>
      </div>
    </div>
  );
}
