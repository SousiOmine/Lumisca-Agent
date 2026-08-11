import {
  type ClipboardEvent,
  type ComponentType,
  type DragEvent,
  type KeyboardEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  IconBrain,
  IconCheck,
  IconChevronRight,
  IconFile,
  IconFolder,
  IconPlayerStop,
  IconX,
} from "@tabler/icons-react";
import { THINKING_LEVEL_LABELS } from "@lumisca/core/shared";
import { api, fed } from "../api.ts";
import { ModelPicker } from "./ModelPicker.tsx";
import type {
  ModelInfo,
  PendingImage,
  ThinkingLevel,
  WorkspaceFileEntry,
} from "../types.ts";

/** Maximum attachments accepted per prompt (mirrors the server limit). */
const MAX_IMAGES = 8;

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
  submitIcon?: ComponentType<{ size?: number }>;
  /** Icon-only submit: hide the label text; submitLabel is still used as
   * the accessible name and tooltip. */
  submitIconOnly?: boolean;
  submitDisabled?: boolean;
  /** Show an abort button instead of submit while the agent is running. */
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
  /** Open the settings modal from the model picker's "Manage models" link. */
  onOpenSettings?: () => void;
  /** When set, typing `@` offers workspace files/folders to insert as
   * `FolderName/rel/path`. The workspace may live on a peer (`mentionPeerId`
   * non-empty), in which case suggestions come from that machine. */
  mentionWorkspaceId?: string;
  mentionPeerId?: string;
  /** Images attached for the next send (data URLs). Dropped/pasted files
   * are appended here; the parent clears them after a successful submit. */
  images?: PendingImage[];
  onImagesChange?: (images: PendingImage[]) => void;
}

/** An active `@` mention: the caret is inside a query started by `@`. */
interface MentionState {
  /** Index of the `@` character in the input. */
  start: number;
  query: string;
  items: WorkspaceFileEntry[];
  active: number;
  loading: boolean;
}

/** Find the `@query` under the caret. `@` must start a word (preceded by
 * whitespace or a non-word character such as punctuation — Japanese text
 * counts), so emails like `foo@bar` never trigger. */
function detectMention(
  value: string,
  caret: number,
): { start: number; query: string } | null {
  const before = value.slice(0, caret);
  const match = /(^|[^\w])@([^\s]*)$/.exec(before);
  if (!match || match[1] === undefined) return null;
  return { start: match.index + match[1].length, query: match[2] ?? "" };
}

/** Pixel position of the caret within the textarea (mirror-div technique:
 * clone the textarea's metrics, render the text up to the caret, and read
 * where a marker span lands). The marker's rect is offset by the mirror's
 * own rect, so the result is relative to the mirror — and, because the
 * textarea and its wrapper share a top-left origin, to the popover's
 * containing block — regardless of any transform on an ancestor. */
function measureCaret(
  textarea: HTMLTextAreaElement,
): { x: number; y: number } {
  const pos = textarea.selectionStart;
  const style = getComputedStyle(textarea);
  const mirror = document.createElement("div");
  const props = [
    "borderTopWidth",
    "borderRightWidth",
    "borderBottomWidth",
    "borderLeftWidth",
    "paddingTop",
    "paddingRight",
    "paddingBottom",
    "paddingLeft",
    "fontFamily",
    "fontSize",
    "fontWeight",
    "lineHeight",
    "letterSpacing",
    "wordSpacing",
    "textIndent",
    "textTransform",
  ] as const;
  for (const prop of props) {
    mirror.style.setProperty(prop, style.getPropertyValue(prop));
  }
  mirror.style.position = "fixed";
  mirror.style.visibility = "hidden";
  mirror.style.left = "0";
  mirror.style.top = "0";
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.wordBreak = "break-word";
  const before = textarea.value.slice(0, pos);
  mirror.textContent = before;
  if (before.endsWith("\n")) mirror.appendChild(document.createElement("br"));
  const marker = document.createElement("span");
  marker.textContent = textarea.value.slice(pos) || " ";
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  const mirrorRect = mirror.getBoundingClientRect();
  const markerRect = marker.getBoundingClientRect();
  document.body.removeChild(mirror);
  return {
    x: markerRect.left - mirrorRect.left,
    y: markerRect.top - mirrorRect.top,
  };
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
  images = [],
  onImagesChange,
}: ComposerProps) {
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [showThinkingPicker, setShowThinkingPicker] = useState(false);
  const [mention, setMention] = useState<MentionState | null>(null);
  const [caretPos, setCaretPos] = useState<{ x: number; y: number } | null>(
    null,
  );
  const [dragging, setDragging] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Bumped per fetch so a stale response can never overwrite a newer one.
  const fetchSeq = useRef(0);
  // Latest images, read inside the async FileReader callback so a burst of
  // drops/pastes never appends from a stale closure.
  const imagesRef = useRef(images);
  imagesRef.current = images;

  const mentionEnabled = mentionWorkspaceId !== undefined;

  /** Add a pasted/dropped image file to the attachments. */
  const addImage = (file: File) => {
    if (imagesRef.current.length >= MAX_IMAGES) return;
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
    const files = Array.from(e.clipboardData.items)
      .filter((item) => item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((f): f is File => f !== null);
    if (files.length === 0) return;
    e.preventDefault(); // never paste raw image bytes into the textarea
    for (const file of files) addImage(file);
  };

  const handleDragOver = (e: DragEvent) => {
    if (e.dataTransfer.types.includes("Files")) {
      e.preventDefault();
      setDragging(true);
    }
  };

  const handleDragLeave = (e: DragEvent) => {
    // Fires when entering children; only clear when leaving the composer.
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setDragging(false);
  };

  const handleDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    for (const file of Array.from(e.dataTransfer.files)) {
      if (file.type.startsWith("image/")) addImage(file);
    }
  };

  /** Re-evaluate the mention under the caret after typing or caret moves. */
  const updateMention = (nextValue: string, caret: number) => {
    const det = mentionEnabled ? detectMention(nextValue, caret) : null;
    if (!det) {
      if (mention !== null) {
        setMention(null);
        setCaretPos(null);
      }
      return;
    }
    setMention((prev) =>
      prev && prev.start === det.start
        ? { ...prev, query: det.query, loading: true }
        : {
          start: det.start,
          query: det.query,
          items: [],
          active: 0,
          loading: true,
        }
    );
    const ta = textareaRef.current;
    if (ta) setCaretPos(measureCaret(ta));
  };

  // Debounced fetch of suggestions whenever the mention query changes.
  useEffect(() => {
    if (!mention || !mention.loading || !mentionWorkspaceId) return;
    const seq = ++fetchSeq.current;
    const timer = setTimeout(async () => {
      try {
        const result = mentionPeerId === ""
          ? await api.workspaceFiles(mentionWorkspaceId, mention.query)
          : await fed.workspaceFiles(
            mentionPeerId,
            mentionWorkspaceId,
            mention.query,
          );
        if (fetchSeq.current !== seq || !mention) return;
        setMention((prev) =>
          prev ? { ...prev, items: result.entries, loading: false } : prev
        );
      } catch {
        if (fetchSeq.current !== seq || !mention) return;
        setMention((prev) =>
          prev ? { ...prev, items: [], loading: false } : prev
        );
      }
    }, 150);
    return () => clearTimeout(timer);
  }, [mention, mentionWorkspaceId, mentionPeerId]);

  // Switching sessions (different workspace) must not leak a stale mention.
  useEffect(() => {
    setMention(null);
    setCaretPos(null);
  }, [mentionWorkspaceId, mentionPeerId]);

  /** Replace `@query` with the picked path (plus a trailing space). */
  const selectMention = (index: number) => {
    const current = mention;
    const ta = textareaRef.current;
    if (!current || !ta) return;
    const item = current.items[index];
    if (!item) return;
    const caret = ta.selectionStart;
    const inserted = item.path;
    const next = value.slice(0, current.start) + inserted + " " +
      value.slice(caret);
    onChange(next);
    setMention(null);
    setCaretPos(null);
    fetchSeq.current++;
    const caretAfter = current.start + inserted.length + 1;
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(caretAfter, caretAfter);
    });
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && e.ctrlKey) {
      e.preventDefault();
      onSubmit();
      return;
    }
    if (mention && mention.items.length > 0) {
      const count = mention.items.length;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMention({
          ...mention,
          active: (mention.active + 1) % count,
        });
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMention({
          ...mention,
          active: (mention.active - 1 + count) % count,
        });
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        selectMention(mention.active);
        return;
      }
    }
    if (mention && e.key === "Escape") {
      e.preventDefault();
      setMention(null);
      setCaretPos(null);
      return;
    }
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
            onChange(e.target.value);
            updateMention(e.target.value, e.target.selectionStart);
          }}
          onSelect={(e) => {
            updateMention(
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
      </div>
      <div className="input-row">
        {hideModelSwitch
          ? (
            <span className="settings-note" style={{ alignSelf: "center" }}>
              接続先サーバーの既定モデルを使用します
            </span>
          )
          : (
            <div className="model-switch-bar">
              <button
                type="button"
                className="model-switch"
                onClick={() => {
                  setShowModelPicker((o) => !o);
                  setShowThinkingPicker(false);
                }}
                title="モデルを選択"
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
                <span className={`chevron${showModelPicker ? " open" : ""}`}>
                  <IconChevronRight size={13} />
                </span>
              </button>
              {canThink && onThinkingLevelChange && (
                <div className="thinking-control">
                  <button
                    type="button"
                    className="thinking-switch"
                    onClick={() => {
                      setShowThinkingPicker((o) => !o);
                      setShowModelPicker(false);
                    }}
                    title="思考強度"
                  >
                    <IconBrain size={13} />
                    <span>{THINKING_LEVEL_LABELS[thinkingLevel ?? "off"]}</span>
                    <span
                      className={`chevron${showThinkingPicker ? " open" : ""}`}
                    >
                      <IconChevronRight size={13} />
                    </span>
                  </button>
                  {showThinkingPicker && (
                    <div className="thinking-popover">
                      {levels.map((level) => (
                        <button
                          key={level}
                          type="button"
                          className={`thinking-option${
                            (thinkingLevel ?? "off") === level
                              ? " selected"
                              : ""
                          }`}
                          onClick={() => {
                            onThinkingLevelChange(level);
                            setShowThinkingPicker(false);
                          }}
                        >
                          <span>{THINKING_LEVEL_LABELS[level]}</span>
                          {(thinkingLevel ?? "off") === level && (
                            <IconCheck size={13} className="thinking-check" />
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {showModelPicker && (
                <div className="model-popover">
                  <ModelPicker
                    value={model}
                    peerId={peerId}
                    onSelect={(provider, modelId, info) => {
                      onModelSelect(provider, modelId, info);
                      setShowModelPicker(false);
                    }}
                    onOpenSettings={() => {
                      setShowModelPicker(false);
                      onOpenSettings?.();
                    }}
                  />
                </div>
              )}
            </div>
          )}
        {onAbort
          ? (
            <button type="button" className="btn danger" onClick={onAbort}>
              <IconPlayerStop size={14} />
              中断
            </button>
          )
          : (
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
          )}
      </div>
    </div>
  );
}
