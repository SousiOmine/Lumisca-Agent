import {
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "preact/compat";
import {
  IconArrowLeft,
  IconBrain,
  IconChevronRight,
  IconFile,
  IconFolder,
  IconPlayerStop,
  IconX,
} from "@tabler/icons-preact";
import { MAX_PROMPT_IMAGES, THINKING_LEVEL_LABELS } from "@lumisca/core/shared";
import {
  ContextUsageCard,
  type ContextUsageData,
  ContextUsageTrigger,
} from "./ContextUsage.tsx";
export type { ContextUsageData };
import { ModelPicker } from "./ModelPicker.tsx";
import { useClickOutside } from "../hooks/useClickOutside.ts";
import { useCaretPosition } from "../hooks/useCaretPosition.ts";
import { useMention } from "../hooks/useMention.ts";
import { isSlashCommand, useSlashMenu } from "../hooks/useSlashMenu.ts";
import type { SlashCommand, SlashCommandItem } from "../hooks/useSlashMenu.ts";
export type { SlashCommand, SlashCommandItem };
import type { ModelInfo, PendingImage, ThinkingLevel } from "../types.ts";

export interface ComposerModel {
  provider: string;
  modelId: string;
}

interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  onKeyDown?: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  placeholder?: string;
  autoFocus?: boolean;
  /** Taller, vertically resizable textarea (new-session use). */
  large?: boolean;
  model: ComposerModel | null;
  onModelSelect: (
    provider: string,
    modelId: string,
    info?: ModelInfo,
  ) => void;
  /** Thinking level of the current model; the select appears only when the
   * model supports levels besides "off" (see thinkingLevels). */
  thinkingLevel?: ThinkingLevel;
  thinkingLevels?: ThinkingLevel[];
  onThinkingLevelChange?: (level: ThinkingLevel) => void;
  submitLabel: string;
  /** Optional Tabler icon shown before the submit label. */
  submitIcon?: (props: { size?: string | number }) => ReactNode;
  /** Icon-only submit: hide the label text; submitLabel is still used as
   * the accessible name and tooltip. */
  submitIconOnly?: boolean;
  submitDisabled?: boolean;
  /** Show an abort button next to submit while the agent is running
   * (sending stays enabled so the user can steer the running task). */
  onAbort?: () => void;
  onSubmit: () => void;
  /** Peer owning the session ("" = this server). The model picker then
   * lists the PEER's models, so switching a remote session's model works
   * against the machine that runs the agent. */
  peerId?: string;
  /** Hide the model switch bar entirely (used by the draft tab when the
   * selected workspace is on another server: the session is created with
   * the peer's default model). */
  hideModelSwitch?: boolean;
  /** Open the provider settings from the model picker's "設定画面" link. */
  onOpenSettings?: () => void;
  /** When set, typing `@` offers workspace files/folders to insert as
   * `FolderName/rel/path`. The workspace may live on a peer (`mentionPeerId`
   * non-empty), in which case suggestions come from that machine. */
  mentionWorkspaceId?: string;
  mentionPeerId?: string;
  /** When set, typing `/` at the start of the input opens a command menu
   * above the textarea (a mode palette). Commands with `items` transition
   * to a second level; selecting a leaf executes it via onSlashCommand.
   * The menu is generic: every caller can pass its own command list. */
  slashCommands?: SlashCommand[];
  /** A slash command (or one of its subcommands) was chosen. The parent
   * builds the actual prompt and submits it; the input is cleared by the
   * parent as with a regular submit. `text` is the composer text typed
   * after the command token (empty for a bare `/command`) — text-taking
   * commands (requiresText) use it as their subject. */
  onSlashCommand?: (
    command: SlashCommand,
    item?: SlashCommandItem,
    text?: string,
  ) => void;
  /** Images attached for the next send (data URLs). Dropped/pasted files
   * are appended here; the parent clears them after a successful submit. */
  images?: PendingImage[];
  onImagesChange?: (images: PendingImage[]) => void;
  /** Context usage for the meter + popover above the footer (undefined
   * hides it: the session has no assistant usage yet). */
  contextUsage?: ContextUsageData;
}

/** Shared chat input: textarea + model picker + submit, in one rounded box.
 * Enter/Shift+Enter insert a newline; Ctrl+Enter submits. */
export function Composer({
  value,
  onChange,
  onKeyDown,
  placeholder,
  autoFocus,
  large,
  model,
  onModelSelect,
  thinkingLevel,
  thinkingLevels,
  onThinkingLevelChange,
  submitLabel,
  submitIcon: SubmitIcon,
  submitIconOnly,
  submitDisabled,
  onAbort,
  onSubmit,
  peerId,
  hideModelSwitch,
  onOpenSettings,
  mentionWorkspaceId,
  mentionPeerId = "",
  slashCommands,
  onSlashCommand,
  images = [],
  onImagesChange,
  contextUsage,
}: ComposerProps) {
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [showCtx, setShowCtx] = useState(false);
  const [dragging, setDragging] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Latest images, read inside the async FileReader callback so a burst of
  // drops/pastes never appends from a stale closure. The ref is kept in an
  // effect: writing it during render breaks under concurrent rendering.
  const imagesRef = useRef(images);
  useEffect(() => {
    imagesRef.current = images;
  }, [images]);
  // The pickers close on outside click and Escape, like every other
  // dropdown (the refs wrap the trigger button + popover, so toggling the
  // trigger keeps working).
  const modelPickerRef = useRef<HTMLDivElement>(null);
  const ctxRef = useRef<HTMLDivElement>(null);
  useClickOutside(
    modelPickerRef,
    () => setShowModelPicker(false),
    showModelPicker,
  );
  useClickOutside(ctxRef, () => setShowCtx(false), showCtx);

  const slashEnabled = slashCommands !== undefined;

  const { caretPos, setCaretPos, measure: measureCaret } = useCaretPosition(
    textareaRef,
  );
  const clearCaret = useCallback(() => setCaretPos(null), [setCaretPos]);
  const {
    mention,
    setMention,
    updateMention,
    selectMention,
    closeMention,
    handleKeyDown: handleMentionKeyDown,
  } = useMention({
    textareaRef,
    workspaceId: mentionWorkspaceId,
    peerId: mentionPeerId,
    value,
    onChange,
    clearCaret,
  });
  const {
    slash,
    setSlash,
    slashEntries,
    updateSlash,
    resetSlash,
    selectSlash,
    handleKeyDown: handleSlashKeyDown,
  } = useSlashMenu({
    enabled: slashEnabled,
    commands: slashCommands ?? [],
    onSelect: onSlashCommand,
  });

  /** Complete a text-taking command (e.g. `/plan`) to `/id␣` so the user
   * can keep typing its request. Without this the parent sends nothing
   * while the text is missing, which left a bare `/` behind. */
  const completeSlashTo = useCallback(
    (command: SlashCommand) => {
      const ta = textareaRef.current;
      const caret = ta?.selectionStart ?? value.length;
      const start = slash?.start ?? 0;
      const before = value.slice(0, start);
      const after = value.slice(caret).replace(/^\s*/, "");
      const next = `${before}/${command.id} ${after}`;
      onChange(next);
      const caretAfter = before.length + command.id.length + 2;
      // Re-evaluate so the menu filters to the completed command with its
      // "keep typing" hint instead of closing.
      updateSlash(next, caretAfter);
      requestAnimationFrame(() => {
        ta?.focus();
        ta?.setSelectionRange(caretAfter, caretAfter);
      });
    },
    [slash, value, onChange, updateSlash],
  );

  /** Select a slash entry, completing text-taking commands whose request
   * is still missing instead of dropping the selection. */
  const handleSlashPick = useCallback(
    (index: number) => {
      const entry = slashEntries[index];
      if (
        slash && slash.submenu === null && entry !== undefined &&
        isSlashCommand(entry) && entry.requiresText === true &&
        slash.rest.trim().length === 0
      ) {
        completeSlashTo(entry);
        return;
      }
      selectSlash(index);
    },
    [slash, slashEntries, completeSlashTo, selectSlash],
  );

  // Switching sessions (different workspace) must not leak a stale mention
  // or slash command.
  useEffect(() => {
    closeMention();
    resetSlash();
  }, [mentionWorkspaceId, mentionPeerId, closeMention, resetSlash]);

  /** Add a pasted/dropped image file to the attachments. */
  const addImage = (file: File) => {
    if (imagesRef.current.length >= MAX_PROMPT_IMAGES) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== "string") return;
      onImagesChange?.([
        ...imagesRef.current,
        {
          data: reader.result,
          mimeType: file.type || "image/png",
          name: file.name,
        },
      ]);
    };
    reader.readAsDataURL(file);
  };

  /** Paste support: image items in the clipboard become attachments; text
   * pastes behave as usual (no preventDefault). */
  const handlePaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData?.items ?? [])
      .filter((item) => item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((f): f is File => f !== null);
    if (files.length === 0) return;
    e.preventDefault(); // never paste raw image bytes into the textarea
    for (const file of files) addImage(file);
  };

  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (e.dataTransfer?.types.includes("Files")) {
      e.preventDefault();
      setDragging(true);
    }
  };

  const handleDragLeave = (e: DragEvent<HTMLDivElement>) => {
    // Fires when entering children; only clear when leaving the composer.
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setDragging(false);
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    for (const file of Array.from(e.dataTransfer?.files ?? [])) {
      if (file.type.startsWith("image/")) addImage(file);
    }
  };

  /** Re-evaluate the slash command and the mention under the caret after
   * typing or caret moves. They are mutually exclusive: a matching `/`
   * takes over the input, so the two popovers never overlap. */
  const updateSuggestions = (nextValue: string, caret: number) => {
    if (updateSlash(nextValue, caret)) {
      closeMention();
      return;
    }
    resetSlash();
    if (updateMention(nextValue, caret)) {
      measureCaret();
    } else if (mention !== null) {
      clearCaret();
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && e.ctrlKey) {
      e.preventDefault();
      onSubmit();
      return;
    }
    // Text-taking commands without their request complete to `/id␣` on
    // Enter/Tab instead of being dropped by the menu selection.
    if ((e.key === "Enter" || e.key === "Tab") && slash !== null) {
      const active = slashEntries[slash.active];
      if (
        slash.submenu === null && active !== undefined &&
        isSlashCommand(active) && active.requiresText === true &&
        slash.rest.trim().length === 0
      ) {
        e.preventDefault();
        completeSlashTo(active);
        return;
      }
    }
    if (handleSlashKeyDown(e)) return;
    if (handleMentionKeyDown(e)) return;
    onKeyDown?.(e);
  };

  // Only models that can actually think (more than just "off") get the
  // level selector; the options are the levels the model supports.
  const levels = thinkingLevels ?? [];
  const canThink = levels.length > 1;

  // The popover opens above the caret line. Only in the tall new-session
  // textarea does the caret sit near the top often enough to flip below
  // instead of covering the first lines.
  const showMentionAbove = !(large && caretPos !== null && caretPos.y < 60);

  return (
    <div
      className={`input-composer${dragging ? " dragging" : ""}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {images.length > 0 && (
        <div className="input-images">
          {images.map((image, index) => (
            <div
              key={`${image.name ?? "image"}-${index}`}
              className="input-image"
            >
              <img src={image.data} alt={image.name ?? "attachment"} />
              <button
                type="button"
                className="input-image-remove"
                title="画像を削除"
                onClick={() =>
                  onImagesChange?.(images.filter((_, i) => i !== index))}
              >
                <IconX size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="input-box-wrap">
        <textarea
          ref={textareaRef}
          className={`input-box${large ? " large" : ""}`}
          placeholder={placeholder}
          value={value}
          onChange={(e) => {
            onChange(e.currentTarget.value);
            updateSuggestions(
              e.currentTarget.value,
              e.currentTarget.selectionStart,
            );
          }}
          onSelect={(e) => {
            updateSuggestions(
              e.currentTarget.value,
              e.currentTarget.selectionStart,
            );
          }}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          autoFocus={autoFocus}
        />
        {mention && caretPos && (
          <div
            className="mention-popover"
            style={showMentionAbove
              ? {
                left: caretPos.x,
                bottom: `calc(100% - ${caretPos.y}px + 8px)`,
              }
              : { left: caretPos.x, top: `calc(${caretPos.y}px + 20px)` }}
          >
            {mention.loading && mention.items.length === 0
              ? <div className="mention-status">読み込み中...</div>
              : mention.items.length === 0
              ? (
                <div className="mention-status">
                  一致するファイルがありません
                </div>
              )
              : (
                mention.items.map((item, index) => (
                  <button
                    key={item.path}
                    type="button"
                    className={`mention-item${
                      index === mention.active ? " active" : ""
                    }`}
                    onMouseDown={(e) => {
                      e.preventDefault(); // keep focus in the textarea
                      selectMention(index);
                    }}
                    onMouseEnter={() =>
                      setMention((prev) =>
                        prev ? { ...prev, active: index } : prev
                      )}
                  >
                    {item.isDir
                      ? <IconFolder size={13} className="mention-icon" />
                      : <IconFile size={13} className="mention-icon" />}
                    <span className="mention-item-name">{item.name}</span>
                    <span className="mention-item-path">{item.path}</span>
                  </button>
                ))
              )}
          </div>
        )}
        {slash && (
          <div className="slash-popover">
            {slash.submenu && (
              <div className="slash-submenu-header">
                <button
                  type="button"
                  className="slash-back"
                  title="コマンド一覧に戻る"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() =>
                    setSlash({ ...slash, submenu: null, active: 0 })}
                >
                  <IconArrowLeft size={13} />
                  <span>{slash.submenu.label}</span>
                </button>
              </div>
            )}
            {slashEntries.length === 0
              ? <div className="slash-status">一致するコマンドがありません</div>
              : slashEntries.map((item, index) => (
                <button
                  key={item.id}
                  type="button"
                  className={`slash-item${
                    index === slash.active ? " active" : ""
                  }`}
                  onMouseDown={(e) => {
                    e.preventDefault(); // keep focus in the textarea
                  }}
                  onMouseEnter={() =>
                    setSlash((prev) =>
                      prev ? { ...prev, active: index } : prev
                    )}
                  onClick={() => handleSlashPick(index)}
                >
                  {item.icon && <item.icon size={14} className="slash-icon" />}
                  <span className="slash-item-text">
                    <span className="slash-item-label">{item.label}</span>
                    {item.description && (
                      <span className="slash-item-desc">
                        {item.description}
                      </span>
                    )}
                  </span>
                  {slash.submenu === null && isSlashCommand(item) &&
                    (item.items?.length ?? 0) > 0 && (
                    <IconChevronRight size={13} className="slash-chevron" />
                  )}
                </button>
              ))}
          </div>
        )}
      </div>
      <div className="input-row">
        {hideModelSwitch
          ? (
            <span className="settings-note" style={{ alignSelf: "center" }}>
              接続先サーバーの既定モデルを使用します
            </span>
          )
          : (
            <div className="model-switch-bar" ref={modelPickerRef}>
              <button
                type="button"
                className="model-switch"
                onClick={() => {
                  setShowModelPicker((o) => !o);
                  setShowCtx(false);
                }}
                title="モデル・思考強度を選択"
              >
                <span
                  className="live-dot"
                  style={{
                    background: "var(--text-faint)",
                    width: 6,
                    height: 6,
                  }}
                />
                <span className="mono">
                  {model
                    ? `${model.provider}/${model.modelId}`
                    : "モデルを選択"}
                </span>
                {canThink && (
                  <span className="model-thinking-label">
                    <IconBrain size={12} />
                    <span>
                      {THINKING_LEVEL_LABELS[thinkingLevel ?? "off"]}
                    </span>
                  </span>
                )}
                <span className={`chevron${showModelPicker ? " open" : ""}`}>
                  <IconChevronRight size={13} />
                </span>
              </button>
              {showModelPicker && (
                <div className="model-popover">
                  <ModelPicker
                    value={model}
                    peerId={peerId}
                    onSelect={(provider, modelId, info) => {
                      // Stays open: the thinking pane follows the newly
                      // selected model, so strength can be tuned in the
                      // same opening. Closes on outside click / Escape.
                      onModelSelect(provider, modelId, info);
                    }}
                    onOpenSettings={() => {
                      setShowModelPicker(false);
                      onOpenSettings?.();
                    }}
                    thinkingValue={thinkingLevel}
                    thinkingLevels={thinkingLevels}
                    onThinkingChange={onThinkingLevelChange}
                  />
                </div>
              )}
            </div>
          )}
        <div className="input-actions">
          {contextUsage !== undefined && (
            <div className="ctx-wrap" ref={ctxRef}>
              <ContextUsageTrigger
                summary={contextUsage.summary}
                contextWindow={contextUsage.contextWindow}
                open={showCtx}
                onToggle={() => {
                  setShowCtx((o) => !o);
                  setShowModelPicker(false);
                }}
              />
              {showCtx && (
                <ContextUsageCard
                  summary={contextUsage.summary}
                  contextWindow={contextUsage.contextWindow}
                />
              )}
            </div>
          )}
          {onAbort && (
            <button
              type="button"
              className="btn danger"
              onClick={onAbort}
              aria-label="中断"
              title="中断"
            >
              <IconPlayerStop size={14} />
            </button>
          )}
          <button
            type="button"
            className="btn primary"
            onClick={onSubmit}
            disabled={submitDisabled}
            aria-label={submitIconOnly ? submitLabel : undefined}
            title={submitIconOnly ? submitLabel : undefined}
          >
            {SubmitIcon && <SubmitIcon size={14} />}
            {!submitIconOnly && submitLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
