import { MAX_PROMPT_TEXT_LENGTH } from "@lumisca/core/shared";
import type {
  ClipboardEvent,
  DragEvent,
  KeyboardEvent,
  ReactNode,
} from "preact/compat";
import { useEffect, useRef, useState } from "preact/hooks";
import { composerMenuItems } from "../composerMenu.ts";
import { useAttachments } from "../hooks/useAttachments.ts";
import { useAutoGrow } from "../hooks/useAutoGrow.ts";
import { useComposerPalettes } from "../hooks/useComposerPalettes.ts";
import { useT } from "../i18n.ts";
import type { SlashCommand, SlashCommandItem } from "../slashCommands.ts";
import type {
  ModelInfo,
  PendingFile,
  PendingImage,
  PromptUploader,
  ThinkingLevel,
} from "../types.ts";
import {
  type ComposerAttachAction,
  ComposerAttachMenu,
} from "./ComposerAttachMenu.tsx";
import { ComposerAttachments } from "./ComposerAttachments.tsx";
import { ComposerFooter } from "./ComposerFooter.tsx";
import type { ComposerModel } from "./ComposerModelBar.tsx";
import { ComposerSuggestions } from "./ComposerSuggestions.tsx";
import type { ContextUsageData } from "./ContextUsage.tsx";

export type { ComposerModel, ContextUsageData, SlashCommand, SlashCommandItem };

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
  /** Starts one non-image file's transfer. Required when `onFilesChange` is
   * given: the composer holds the File handle, this function knows where the
   * conversation's machine is. */
  onUploadFile?: PromptUploader;
  /** Which machine the files are for (a stella agent id). Changing it cancels
   * the transfers and drops the chips; see useAttachments. */
  fileTarget?: string;
  /** Offer "share a folder" in the plus menu. Only the desktop shell can
   * open a folder picker on this computer, so only it passes this. */
  onShareFolder?: () => void;
  /** Context usage for the meter + popover above the footer (undefined
   * hides it: the session has no assistant usage yet). */
  contextUsage?: ContextUsageData;
  /** Where the meter's bar turns amber: the compaction point when the
   * caller knows it (see shared/context-usage.ts compactionUsageRatio). */
  contextWarnRatio?: number;
  /** Folders lent from the user's own computer are within reach of this
   * message (stella). The capsule says so by taking the state colour; the
   * line above it that counts them belongs to the caller, which is the one
   * that knows about the loans. */
  sharing?: boolean;
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
  onUploadFile,
  fileTarget,
  onShareFolder,
  contextUsage,
  contextWarnRatio,
  sharing = false,
  visible = true,
}: ComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pickerRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
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
  // The two lists above the caret (an `@` path, a `/` command) and what a pick
  // does to the text (see hooks/useComposerPalettes).
  const palettes = useComposerPalettes({
    textareaRef,
    value,
    onChange,
    mentionWorkspaceId,
    mentionPeerId,
    slashCommands,
    onSlashCommand,
    large,
  });
  // Reading attachments (size limits, FileReader, the failure message) lives
  // in the hook: none of it has anything to do with rendering.
  const attachments = useAttachments({
    images,
    files,
    onImagesChange,
    onFilesChange,
    ...(onUploadFile === undefined ? {} : { uploadFile: onUploadFile }),
    ...(fileTarget === undefined ? {} : { fileTarget }),
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

  /** The plus menu's rows: what this composer can put into the message, named
   * for the reader (see composerMenuItems for which rows exist and why). */
  const attachActions: ComposerAttachAction[] = composerMenuItems({
    canSendFiles: onFilesChange !== undefined,
    canMention: mentionWorkspaceId !== undefined,
    canSlash: slashCommands !== undefined,
    canShareFolder: onShareFolder !== undefined,
  }).map((item) => ({
    id: item.id,
    label: t(item.labelKey),
    icon: item.icon,
    run:
      item.id === "attach"
        ? () => pickerRef.current?.click()
        : item.id === "share"
          ? () => onShareFolder?.()
          : () => palettes.openPalette(item.id === "command" ? "/" : "@"),
  }));

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
    if (palettes.handleKeyDown(e)) return;
    onKeyDown?.(e);
  };

  return (
    <div
      className={`input-composer${dragging ? " dragging" : ""}${
        sharing ? " sharing" : ""
      }`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <ComposerAttachments
        error={attachments.error}
        files={files}
        images={images}
        onImagesChange={onImagesChange}
        onRemoveFile={attachments.remove}
      />
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
         * message will be (model, context, send), and a menu there read as
         * one more thing about sending. Hidden input, visible button: the
         * native control is drawn by the OS and cannot take the app's
         * styling.
         *
         * The control is the plus, not the paperclip: it opens everything
         * that can go into the message (a file, a command, a workspace
         * path), and which of those exist is what this composer was handed
         * (see composerMenuItems). */}
        <input
          ref={pickerRef}
          type="file"
          multiple
          // A mode with no machine to put a file in takes pictures only; the
          // dialog then offers nothing it would refuse.
          accept={onFilesChange === undefined ? "image/*" : undefined}
          hidden
          onChange={handlePicked}
        />
        <ComposerAttachMenu
          label={t("chat.composer.attach.open")}
          actions={attachActions}
        />
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
            palettes.updateSuggestions(next, e.currentTarget.selectionStart);
          }}
          onSelect={(e) => {
            palettes.updateSuggestions(
              e.currentTarget.value,
              e.currentTarget.selectionStart,
            );
          }}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          autoFocus={autoFocus}
        />
        <ComposerSuggestions
          caretPos={palettes.caretPos}
          showMentionAbove={palettes.showMentionAbove}
          mention={palettes.mention}
          setMention={palettes.setMention}
          selectMention={palettes.selectMention}
          slash={palettes.slash}
          setSlash={palettes.setSlash}
          slashEntries={palettes.slashEntries}
          selectSlash={palettes.selectSlash}
        />
      </div>
      <ComposerFooter
        modelBar={modelBar}
        model={model}
        peerId={peerId}
        thinkingLevel={thinkingLevel}
        thinkingLevels={thinkingLevels}
        onModelSelect={onModelSelect}
        onThinkingLevelChange={onThinkingLevelChange}
        onOpenSettings={onOpenSettings}
        contextUsage={contextUsage}
        contextWarnRatio={contextWarnRatio}
        onAbort={onAbort}
        onSubmit={onSubmit}
        submitLabel={submitLabel}
        submitIcon={SubmitIcon}
        submitIconOnly={submitIconOnly}
        submitDisabled={submitDisabled || attachments.overflow}
      />
    </div>
  );
}
