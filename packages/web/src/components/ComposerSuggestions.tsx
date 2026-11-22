import {
  IconArrowLeft,
  IconChevronRight,
  IconFile,
  IconFolder,
} from "@tabler/icons-preact";
import type { Dispatch, SetStateAction } from "preact/compat";
import type { MentionState } from "../hooks/useMention.ts";
import { isSlashCommand, type SlashState } from "../hooks/useSlashMenu.ts";
import { useT } from "../i18n.ts";
import type { SlashCommandItem } from "../slashCommands.ts";
import { ComposerPopover } from "./ComposerPopover.tsx";

/**
 * The two lists the field offers above its caret: workspace paths (`@`) and
 * commands (`/`).
 *
 * They are drawn by the same control (ComposerPopover) and described by the
 * same state (hooks/useComposerPalettes), so they belong in one place; split
 * out of Composer.tsx because neither list knows anything about typing —
 * each is handed the rows, the active index and what a pick does.
 *
 * The rows differ on purpose: a mention is an icon, a name and a path; a
 * command is an icon, a label, a description and a chevron when it opens a
 * submenu. That difference belongs to the markup, not to the list.
 */
export function ComposerSuggestions({
  caretPos,
  showMentionAbove,
  mention,
  setMention,
  selectMention,
  slash,
  setSlash,
  slashEntries,
  selectSlash,
}: {
  /** Caret position in the textarea, or null while no mention is open. */
  caretPos: { x: number; y: number } | null;
  /** Whether the mention list opens above the caret line (the tall
   * new-session field flips it below instead of covering its first lines). */
  showMentionAbove: boolean;
  mention: MentionState | null;
  setMention: Dispatch<SetStateAction<MentionState | null>>;
  selectMention: (index: number) => void;
  slash: SlashState | null;
  setSlash: Dispatch<SetStateAction<SlashState | null>>;
  slashEntries: SlashCommandItem[];
  selectSlash: (index: number) => void;
}) {
  const t = useT();
  return (
    <>
      {mention && caretPos && (
        <ComposerPopover
          className="mention-popover"
          {...(showMentionAbove ? {} : { placementClass: "below" })}
          /* The caret position is handed to the stylesheet as variables
           * rather than as final offsets: the sheet decides where that
           * puts the list, so a narrow layout can pin it to the composer
           * (a caret-anchored list would run off the right edge). */
          style={{
            "--caret-x": `${caretPos.x}px`,
            "--caret-y": `${caretPos.y}px`,
          }}
          items={mention.items}
          active={mention.active}
          // A mention commits on mousedown: its selection rewrites the
          // token under the caret, which must still be where it was.
          commit="mousedown"
          keyOf={(item) => item.path}
          onSelect={selectMention}
          onHover={(index) =>
            setMention((prev) => (prev ? { ...prev, active: index } : prev))
          }
          empty={
            mention.loading && mention.items.length === 0 ? (
              <div className="mention-status">{t("common.loading")}</div>
            ) : mention.failed ? (
              <div className="mention-status">
                {t("chat.composer.mention.failed")}
              </div>
            ) : (
              <div className="mention-status">
                {t("chat.composer.mention.noMatch")}
              </div>
            )
          }
          renderRow={(item) => (
            <>
              {item.isDir ? (
                <IconFolder size={13} className="mention-icon" />
              ) : (
                <IconFile size={13} className="mention-icon" />
              )}
              <span className="mention-item-name">{item.name}</span>
              <span className="mention-item-path">{item.path}</span>
            </>
          )}
        />
      )}
      {slash && (
        <ComposerPopover
          className="slash-popover"
          items={slashEntries}
          active={slash.active}
          // A command commits on click: its handler moves the caret itself
          // (it replaces the token), so it does not need the pre-blur
          // timing a mention does. The mousedown preventDefault still
          // keeps the focus in the textarea.
          commit="click"
          keyOf={(item) => item.id}
          onSelect={selectSlash}
          onHover={(index) =>
            setSlash((prev) => (prev ? { ...prev, active: index } : prev))
          }
          header={
            slash.submenu ? (
              <div className="slash-submenu-header">
                <button
                  type="button"
                  className="slash-back"
                  title={t("chat.composer.slash.back")}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() =>
                    setSlash({ ...slash, submenu: null, active: 0 })
                  }
                >
                  <IconArrowLeft size={13} />
                  <span>{slash.submenu.label}</span>
                </button>
              </div>
            ) : undefined
          }
          empty={
            <div className="slash-status">{t("chat.composer.slash.empty")}</div>
          }
          renderRow={(item) => (
            <>
              {item.icon && <item.icon size={14} className="slash-icon" />}
              <span className="slash-item-text">
                <span className="slash-item-label">{item.label}</span>
                {item.description && (
                  <span className="slash-item-desc">{item.description}</span>
                )}
              </span>
              {slash.submenu === null &&
                isSlashCommand(item) &&
                (item.items?.length ?? 0) > 0 && (
                  <IconChevronRight size={13} className="slash-chevron" />
                )}
            </>
          )}
        />
      )}
    </>
  );
}
