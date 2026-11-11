import {
  formatAttachmentSize,
  MAX_PROMPT_TEXT_LENGTH,
} from "@lumisca/core/shared";
import {
  IconArrowLeft,
  IconChevronRight,
  IconFile,
  IconFolder,
  IconPaperclip,
  IconPlayerStop,
  IconX,
} from "@tabler/icons-preact";
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
  ContextUsageCard,
  type ContextUsageData,
  ContextUsageTrigger,
} from "./ContextUsage.tsx";

export type { ContextUsageData };

import { useAttachments } from "../hooks/useAttachments.ts";
import { useAutoGrow } from "../hooks/useAutoGrow.ts";
import { useCaretPosition } from "../hooks/useCaretPosition.ts";
import { useClickOutside } from "../hooks/useClickOutside.ts";
import { useMention } from "../hooks/useMention.ts";
import { usePopoverPlacement } from "../hooks/usePopoverPlacement.ts";
import {
  isSlashCommand,
  type SlashState,
  useSlashMenu,
} from "../hooks/useSlashMenu.ts";
import {
  type SlashCommand,
  type SlashCommandItem,
  slashCompletion,
} from "../slashCommands.ts";
import { ComposerModelBar } from "./ComposerModelBar.tsx";
import { ComposerPopover } from "./ComposerPopover.tsx";

export type { SlashCommand, SlashCommandItem };

import { useT } from "../i18n.ts";
import type {
  ModelInfo,
  PendingFile,
  PendingImage,
  ThinkingLevel,
} from "../types.ts";

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
  onModelSelect: (provider: string, modelId: string, info?: ModelInfo) => void;
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
  /** Whether the footer shows the model picker. `none` says nothing at all —
   * stella's model is configuration, and a line explaining that is one more
   * thing to read on every message. */
  modelBar?: "picker" | "none";
  /** Open the provider settings from the model picker's "設定画面" link. */
  onOpenSettings?: () => void;
  /** When set, typing `@` offers workspace files/folders to insert as
   * `FolderName/rel/path`. The workspace may live on a peer (`mentionPeerId`
   * non-empty), in which case suggestions come from that machine. */
  mentionWorkspaceId?: string;
  mentionPeerId?: string;
  /** When set, typing `/` (at the start of the input or after whitespace,
   * anywhere in the text) opens a command menu above the textarea (a mode
   * palette). Commands with `items` transition to a second level first;
   * picking a leaf applies its `kind` to the text here — completing a
   * text-taking command (`/plan `) or inserting a saved prompt. The menu
   * is generic: every caller can pass its own command list. */
  slashCommands?: SlashCommand[];
  /** A `run` or `action` command (or one of its subcommands) was picked at
   * the start of the input: the parent builds the mode prompt and submits
   * it, or runs the client-side command. The other kinds never reach the
   * parent (the text is edited here). */
  onSlashCommand?: (command: SlashCommand, item?: SlashCommandItem) => void;
  /** Images attached for the next send (data URLs). Dropped/pasted files
   * are appended here; the parent clears them after a successful submit. */
  images?: PendingImage[];
  onImagesChange?: (images: PendingImage[]) => void;
  /** Non-image files attached for the next send. Only a session with a
   * machine to put them in sends them (stella): leaving `onFilesChange` out
   * says this mode has no such machine, and a file dropped or picked for it
   * is then refused with the reason instead of disappearing (see
   * useAttachments). */
  files?: PendingFile[];
  onFilesChange?: (files: PendingFile[]) => void;
  /** Context usage for the meter + popover above the footer (undefined
   * hides it: the session has no assistant usage yet). */
  contextUsage?: ContextUsageData;
  /** Where the meter's bar turns amber: the compaction point when the
   * caller knows it (see shared/context-usage.ts compactionUsageRatio). */
  contextWarnRatio?: number;
  /** Whether this composer is on screen. A tab pane another tab is showing
   * keeps its composer mounted (see SessionPane) with no box, so the field
   * must not measure itself there; it does so again when the pane is shown. */
  visible?: boolean;
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
  modelBar = "picker",
  onOpenSettings,
  mentionWorkspaceId,
  mentionPeerId = "",
  slashCommands,
  onSlashCommand,
  images = [],
  onImagesChange,
  files = [],
  onFilesChange,
  contextUsage,
  contextWarnRatio,
  visible = true,
}: ComposerProps) {
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [showCtx, setShowCtx] = useState(false);
  const [dragging, setDragging] = useState(false);
  // Why the last pick or drop was refused, shown above the field. A file that
  // exceeds the server's limit would otherwise upload in full and come back
  // as a 400 after the composer had already been emptied.
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pickerRef = useRef<HTMLInputElement>(null);
  // The field grows with the message up to the twelve lines the stylesheet
  // allows (composer.css); the sheet owns the ceiling, this only fits the
  // text.
  useAutoGrow(textareaRef, value, visible);
  // The draft pane is mounted once and kept (see SessionPane), so its field is
  // no longer a fresh mount each time the tab is opened: focus it when its
  // pane is shown again, which is what opening the tab used to do.
  const wasVisible = useRef(visible);
  useEffect(() => {
    if (autoFocus && visible && !wasVisible.current) {
      textareaRef.current?.focus();
    }
    wasVisible.current = visible;
  }, [autoFocus, visible]);
  /** Message lookup of the app language (the composer's own labels). */
  const t = useT();
  // Latest images, read inside the async FileReader callback so a burst of
  // drops/pastes never appends from a stale closure. The ref is kept in an
  // effect: writing it during render breaks under concurrent rendering.
  const imagesRef = useRef(images);
  useEffect(() => {
    imagesRef.current = images;
  }, [images]);
  // The pickers close on outside click and Escape, like every other
  // dropdown (the refs wrap the trigger button + popover, so toggling the
  // trigger keeps working). The model popover is portaled to the body — the
  // chat pane clips its overflowing descendants, and the composer it hangs
  // over is the last thing inside that pane — so the portal is handed in as a
  // second "inside": a click on the popover is not a click outside.
  const modelPickerRef = useRef<HTMLDivElement>(null);
  const modelPopoverRef = useRef<HTMLDivElement>(null);
  const modelPlacement = usePopoverPlacement(modelPickerRef, showModelPicker);
  const ctxRef = useRef<HTMLDivElement>(null);
  useClickOutside(
    modelPickerRef,
    () => setShowModelPicker(false),
    showModelPicker,
    { within: modelPopoverRef },
  );
  useClickOutside(ctxRef, () => setShowCtx(false), showCtx);

  const slashEnabled = slashCommands !== undefined;

  const {
    caretPos,
    setCaretPos,
    measure: measureCaret,
  } = useCaretPosition(textareaRef);
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
  /** Replace the `/command` token the pick was made from with `text`,
   * keeping the text around it: the palette edits the input in place
   * instead of replacing the whole message. `trimAfter` drops the
   * whitespace that followed the token, so completing to `/plan ` does not
   * double the space it inserts. The caret lands right after the inserted
   * text (the textarea keeps focus: the popover suppresses its own
   * mousedown). */
  const replaceSlashToken = useCallback(
    (state: SlashState, text: string, trimAfter: boolean) => {
      const ta = textareaRef.current;
      const caret = ta?.selectionStart ?? state.end;
      const before = value.slice(0, state.start);
      let after = value.slice(Math.max(state.end, caret));
      if (trimAfter) after = after.replace(/^\s+/, "");
      onChange(before + text + after);
      const caretAfter = before.length + text.length;
      requestAnimationFrame(() => {
        ta?.focus();
        ta?.setSelectionRange(caretAfter, caretAfter);
      });
    },
    [value, onChange],
  );

  /** Apply a slash entry picked by click, Enter or Tab. Text-taking
   * commands (`/plan`, `/goal`) are completed to `/id ` and the menu
   * closes: the request is typed after the token like normal input and
   * wrapped into the mode prompt on submit (see ChatView/NewSessionView) —
   * picking the command never sends by itself. A command with subcommands
   * completes to `/id <picked item> ` (the skill palette), so the picked
   * entry stays an argument of the command line. Saved prompts are inserted
   * where the command was typed. Mode palettes run through the parent, but
   * only from the start of the input: their prompt replaces the whole
   * message, so a command typed mid-text is left alone instead of
   * discarding the text around it. */
  const handleSlashSelect = useCallback(
    (
      command: SlashCommand,
      item: SlashCommandItem | undefined,
      state: SlashState,
    ) => {
      if (command.kind === "complete") {
        replaceSlashToken(state, slashCompletion(command, item), true);
        return;
      }
      // An action command that takes an argument completes to `/id ` like a
      // text-taking mode: the argument is typed after the token and read
      // back on submit (see actionCommandFromText). The menu stays a
      // palette, never a sender.
      if (command.kind === "action" && command.takesText === true) {
        replaceSlashToken(state, slashCompletion(command, item), true);
        return;
      }
      if (command.kind === "insert") {
        const insert = item?.insertText ?? command.insertText;
        if (insert !== undefined) replaceSlashToken(state, insert, false);
        return;
      }
      // "run" and "action" replace the whole message (a mode prompt, or a
      // client-side command that sends nothing), so they only apply from
      // the start of the input.
      if (value.slice(0, state.start).trim() === "") {
        onSlashCommand?.(command, item);
      }
    },
    [value, replaceSlashToken, onSlashCommand],
  );

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
    onSelect: handleSlashSelect,
  });

  // Switching sessions (different workspace) must not leak a stale mention
  // or slash command.
  useEffect(() => {
    closeMention();
    resetSlash();
  }, [mentionWorkspaceId, mentionPeerId, closeMention, resetSlash]);

  // Same reason as imagesRef: a burst of drops must not append from a stale
  // closure.
  const filesRef = useRef(files);
  useEffect(() => {
    filesRef.current = files;
  }, [files]);

  // Reading attachments (size limits, FileReader, the failure message) lives
  // in the hook: none of it has anything to do with rendering.
  const attachments = useAttachments({
    images,
    files,
    onImagesChange,
    onFilesChange,
    t,
  });

  /** The picker's input is cleared after every answer so picking the same
   * file twice still fires `change`. */
  const handlePicked = (e: Event) => {
    const input = e.currentTarget as HTMLInputElement;
    attachments.addAll(Array.from(input.files ?? []));
    input.value = "";
  };

  /** Paste support: image items in the clipboard become attachments; text
   * pastes behave as usual (no preventDefault). */
  const handlePaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const images = Array.from(e.clipboardData?.items ?? [])
      .filter((item) => item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((f): f is File => f !== null);
    if (images.length === 0) return;
    e.preventDefault(); // never paste raw image bytes into the textarea
    attachments.addAll(images);
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
    attachments.addAll(Array.from(e.dataTransfer?.files ?? []));
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
    // An IME is composing: Enter confirms the conversion and Escape cancels
    // it. Both are the input method's keys until the composition ends, so
    // the popovers and the send shortcut stay out of the way — otherwise
    // typing Japanese with the slash menu open picked a command instead of
    // the kana the reader was converting. `isComposing` is the property the
    // spec defines; `keyCode === 229` is what WebKit reports for the same
    // moment in some IMEs.
    if (e.isComposing || e.keyCode === 229) return;
    // Ctrl+Enter sends; plain Enter inserts a newline (while the slash menu
    // is open it consumes Enter/Tab to pick the active entry instead).
    if (e.key === "Enter" && e.ctrlKey) {
      e.preventDefault();
      onSubmit();
      return;
    }
    if (handleSlashKeyDown(e)) return;
    if (handleMentionKeyDown(e)) return;
    onKeyDown?.(e);
  };

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
      {attachments.error !== null && (
        <p className="input-attach-error" role="alert">
          {attachments.error}
        </p>
      )}
      {files.length > 0 && (
        <div className="input-files">
          {files.map((file, index) => (
            <span
              key={`${file.name}-${index}`}
              className="input-file"
              title={`${file.name} (${formatAttachmentSize(file.size)})`}
            >
              <IconFile size={13} stroke={1.5} />
              <span className="input-file-name">{file.name}</span>
              <span className="input-file-size">
                {formatAttachmentSize(file.size)}
              </span>
              <button
                type="button"
                className="input-file-remove"
                title={t("chat.composer.image.remove")}
                onClick={() =>
                  onFilesChange?.(files.filter((_, i) => i !== index))
                }
              >
                <IconX size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
      {images.length > 0 && (
        <div className="input-images">
          {images.map((image, index) => (
            <div
              key={`${image.name ?? "image"}-${index}`}
              className="input-image"
            >
              <img
                src={image.data}
                alt={image.name ?? t("chat.composer.image.alt")}
              />
              <button
                type="button"
                className="input-image-remove"
                title={t("chat.composer.image.remove")}
                onClick={() =>
                  onImagesChange?.(images.filter((_, i) => i !== index))
                }
              >
                <IconX size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
      {value.length > MAX_PROMPT_TEXT_LENGTH * 0.9 && (
        // Only near the cap: a counter that is always on screen is one more
        // number to read on every message.
        <p
          className="input-length-note"
          role={value.length >= MAX_PROMPT_TEXT_LENGTH ? "alert" : undefined}
        >
          {t("chat.composer.lengthLeft", {
            count: Math.max(MAX_PROMPT_TEXT_LENGTH - value.length, 0),
          })}
        </p>
      )}
      <div className="input-box-wrap">
        {/* A picker is the only way to attach on a phone: there is no drag
         * and nothing to paste. The control sits at the LEFT of the field,
         * where the writing starts — the row below belongs to what the
         * message will be (model, context, send), and a paperclip there
         * read as one more thing about sending. Hidden input, visible
         * button: the native control is drawn by the OS and cannot take
         * the app's styling. */}
        <input
          ref={pickerRef}
          type="file"
          multiple
          hidden
          onChange={handlePicked}
        />
        <button
          type="button"
          className="icon-btn input-attach"
          onClick={() => pickerRef.current?.click()}
          title={t("chat.composer.attach.pick")}
          aria-label={t("chat.composer.attach.pick")}
        >
          <IconPaperclip size={15} />
        </button>
        <textarea
          ref={textareaRef}
          className={`input-box${large ? " large" : ""}`}
          placeholder={placeholder}
          aria-label={t("chat.composer.label")}
          value={value}
          onChange={(e) => {
            // Pasted text arrives here whole, so this is where the cap is
            // applied: the value is not replaced with a truncated copy (that
            // would cut the reader's text without telling them), the input
            // simply stops growing and the counter below says why.
            const next = e.currentTarget.value;
            if (next.length > MAX_PROMPT_TEXT_LENGTH) return;
            onChange(next);
            updateSuggestions(next, e.currentTarget.selectionStart);
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
              <div className="slash-status">
                {t("chat.composer.slash.empty")}
              </div>
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
      </div>
      <div className="input-row">
        <ComposerModelBar
          mode={modelBar}
          model={model}
          peerId={peerId}
          thinkingLevel={thinkingLevel}
          thinkingLevels={thinkingLevels}
          onModelSelect={onModelSelect}
          onThinkingLevelChange={onThinkingLevelChange}
          onOpenSettings={onOpenSettings}
          open={showModelPicker}
          onOpenChange={(next) => {
            setShowModelPicker(next);
            if (next) setShowCtx(false);
          }}
          triggerRef={modelPickerRef}
          popoverRef={modelPopoverRef}
          placement={modelPlacement}
        />
        <div className="input-actions">
          {contextUsage !== undefined && (
            <div className="ctx-wrap" ref={ctxRef}>
              <ContextUsageTrigger
                summary={contextUsage.summary}
                contextWindow={contextUsage.contextWindow}
                warnRatio={contextWarnRatio}
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
                  warnRatio={contextWarnRatio}
                />
              )}
            </div>
          )}
          {onAbort && (
            <button
              type="button"
              className="btn danger"
              onClick={onAbort}
              aria-label={t("chat.composer.stop")}
              title={t("chat.composer.stop")}
            >
              <IconPlayerStop size={14} />
            </button>
          )}
          <button
            type="button"
            className={`btn primary${submitIconOnly ? "" : " btn-with-label"}`}
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
