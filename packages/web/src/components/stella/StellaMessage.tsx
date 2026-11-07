import {
  IconArrowBackUp,
  IconCheck,
  IconClipboard,
} from "@tabler/icons-preact";
import type { ComponentChildren } from "preact";
import { useMemo } from "preact/compat";
import {
  parseUiMarkup,
  resolveUiView,
  type UiResolvedView,
} from "@lumisca/core/shared";
import { useLocale, useT } from "../../i18n.ts";
import { formatClockTime } from "../../format.ts";
import { useCopy } from "../../hooks/useSave.ts";
import type { StellaEntry } from "../../types.ts";
import { PromptFiles } from "./PromptFiles.tsx";
import { AttachmentCard } from "../chat/AttachmentCard.tsx";
import { MarkdownBlock } from "../chat/MarkdownBlock.tsx";
import { UiCard } from "../chat/UiCard.tsx";
import { AgentAvatar } from "./AgentAvatar.tsx";

/**
 * The agent a conversation's messages are drawn with: enough to name it and
 * to draw its face, which is all a bubble needs.
 */
export interface MessageAuthor {
  id: string;
  name: string;
  icon: string;
}

/**
 * One message of a stella conversation, as a message app draws it: the
 * agent's face at the start of a run of its messages, the bubble beside it,
 * and the time under the last one.
 *
 * The shape carries the reading order. The user's messages are a capsule at
 * the right edge (`.msg.user`, the same rule code mode uses); the agent's
 * are plain text on the sheet at the left, with its face in the margin. A
 * `showAvatar` false is a continuation: the agent spoke twice in a row, so
 * the face and the outer margin are already there and repeating them would
 * make one answer look like several.
 *
 * What a stella bubble can hold is what the server sends (see the core's
 * stella-stream projection): the agent's reply (its text), the card it sent
 * with it, and the files. There is no work log and no tool row to draw,
 * because none ever arrives — a turn's narration is dropped by the same
 * projection, so a bubble is always something the agent addressed to the
 * user.
 */
export function StellaMessage({
  entry,
  author,
  showAvatar,
  entering,
  visualBase,
  attachBase,
  uploadBase,
  onRewind,
  onSend,
}: {
  entry: StellaEntry;
  /** The conversation's agent (every non-user entry is its words). */
  author: MessageAuthor;
  /** False when the previous entry was the same speaker: a continuation
   * drops the repeated face and the gap above it. */
  showAvatar: boolean;
  /** True when this message just arrived at the live edge of the
   * conversation, so it may animate in (see hooks/useArrivals). A message
   * drawn by the first paint — the loaded window, a page of history read
   * back — must not: staging a hundred rows, or flashing history under the
   * reader, is not an arrival. */
  entering: boolean;
  /** Asset base of the conversation (see MarkdownBlock). */
  visualBase: string;
  /** Attachment base of the conversation (the files send_chat sent). */
  attachBase: string;
  /** Where the files a prompt brought in are read back from (the machine,
   * through the conversation's upload route). */
  uploadBase: string;
  /** Rewind from this entry onward (its timestamp names it). */
  onRewind: (timestamp: number, text: string) => void;
  /** Send a card's answer as the user's next message. */
  onSend: (text: string) => void;
}) {
  const locale = useLocale();
  /** The time under the bubble: the clock alone, because the day is the
   * separator's job (see StellaTranscript). */
  const time = (
    <time
      className="msg-time"
      dateTime={new Date(entry.timestamp).toISOString()}
    >
      {formatClockTime(entry.timestamp, locale)}
    </time>
  );

  if (entry.role === "user") {
    return (
      <UserBubble
        entry={entry}
        onRewind={onRewind}
        time={time}
        uploadBase={uploadBase}
      />
    );
  }
  return (
    <AgentBubble
      entry={entry}
      author={author}
      showAvatar={showAvatar}
      entering={entering}
      visualBase={visualBase}
      attachBase={attachBase}
      onSend={onSend}
      time={time}
    />
  );
}

/** The reader's own message: the shared capsule, with the time under it.
 * The rewind and copy actions live in the same row and appear on hover (and
 * always on a touch screen, see chat.css). */
function UserBubble({
  entry,
  onRewind,
  time,
  uploadBase,
}: {
  entry: StellaEntry;
  onRewind: (timestamp: number, text: string) => void;
  time: ComponentChildren;
  uploadBase: string;
}) {
  const { copied, copy } = useCopy(entry.text);
  const t = useT();
  return (
    <div className="msg-user-wrap">
      <div className="msg user">
        <div className="msg-body">
          {entry.text && <p className="msg-user-text">{entry.text}</p>}
          {
            /* The pictures and files the user attached are part of what they
              said, so they sit inside the bubble, under its text. Their bytes
              are read back from the machine, which is where they live. */
          }
          {entry.files.length > 0 && (
            <PromptFiles files={entry.files} base={uploadBase} />
          )}
        </div>
      </div>
      <div className="msg-meta">
        <button
          type="button"
          className="msg-action-btn"
          aria-label={t("chat.message.rewind")}
          onClick={() => onRewind(entry.timestamp, entry.text)}
        >
          <IconArrowBackUp size={16} stroke={1.5} />
        </button>
        {entry.text && (
          <button
            type="button"
            className="msg-action-btn"
            aria-label={t("chat.message.copy")}
            onClick={() => void copy()}
          >
            {copied
              ? <IconCheck size={16} stroke={2} />
              : <IconClipboard size={16} stroke={1.5} />}
          </button>
        )}
        {
          /* Mounted empty and filled on success: a live region has to be in
            the tree before its text changes to be announced. */
        }
        <span className="visually-hidden" role="status">
          {copied ? t("chat.message.copied") : null}
        </span>
        {time}
      </div>
    </div>
  );
}

/** The agent's message: its face in the margin, the words on the sheet. */
function AgentBubble({
  entry,
  author,
  showAvatar,
  entering,
  visualBase,
  attachBase,
  onSend,
  time,
}: {
  entry: StellaEntry;
  author: MessageAuthor;
  showAvatar: boolean;
  /** See StellaMessage's `entering`. */
  entering: boolean;
  visualBase: string;
  attachBase: string;
  onSend: (text: string) => void;
  time: ComponentChildren;
}) {
  const { copied, copy } = useCopy(entry.text);
  const t = useT();
  return (
    <div
      className={`stella-msg${showAvatar ? "" : " continued"}`}
      data-enter={entering || undefined}
    >
      {
        /* The face is decorative: the header names the agent the whole
          conversation is with, so a label on every message would be noise.
          A continuation keeps the column so the text stays aligned. */
      }
      <div className="stella-msg-avatar" aria-hidden="true">
        {showAvatar && (
          <AgentAvatar
            agentId={author.id}
            name={author.name}
            icon={author.icon}
            size={26}
          />
        )}
      </div>
      <div className="stella-msg-main">
        {
          /* `msg-body` as well as stella's own class: the body's shared
           * language (code blocks, inline code, paragraph rhythm) is written
           * once, in chat.css, keyed on that class — the same one the user's
           * bubble and every code-mode body carry. Without it a `<pre>` is
           * an unstyled element with `overflow-x: visible`, so one long line
           * stretched the column and made the whole transcript scroll
           * sideways instead of the code block scrolling inside itself. */
        }
        <div className="stella-msg-body msg-body markdown">
          {entry.text && (
            <MarkdownBlock text={entry.text} visualBase={visualBase} />
          )}
          {entry.card !== null && (
            <CardView markup={entry.card} onSend={onSend} />
          )}
          <AttachmentCard attachments={entry.attachments} base={attachBase} />
        </div>
        {
          /* The time, then the copy control — the same shape as the reader's
           * own message, only mirrored: there the buttons come before the
           * clock because the bubble is right-aligned, here the text starts
           * on the left, so the clock comes first and the button closes the
           * row. Copying the agent's words is what a reader does with an
           * answer (a command, a path, a paragraph) and it was the one
           * message they could not take away. */
        }
        <div className="msg-meta start">
          {time}
          {entry.text && (
            <button
              type="button"
              className="msg-action-btn"
              onClick={() => void copy()}
              title={t("chat.message.copy")}
              aria-label={t("chat.message.copy")}
            >
              {copied
                ? <IconCheck size={16} stroke={2} />
                : <IconClipboard size={16} stroke={1.5} />}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** A card, drawn from the markup the entry carried. Parsing happens here (as
 * it does for code mode's transcript), so a markup this build cannot read
 * shows the "could not be displayed" note rather than half a card. */
function CardView({
  markup,
  onSend,
}: {
  markup: string;
  onSend: (text: string) => void;
}) {
  const view = useMemo<UiResolvedView | null>(() => {
    const parsed = parseUiMarkup(markup);
    return parsed.ok ? resolveUiView(parsed.view) : null;
  }, [markup]);
  return <UiCard view={view} onSend={onSend} />;
}
