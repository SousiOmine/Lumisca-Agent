import {
  IconArrowBackUp,
  IconCheck,
  IconClipboard,
} from "@tabler/icons-preact";
import type { ComponentChildren } from "preact";
import { useMemo } from "preact/compat";
import { parseUiMarkup, type UiView } from "@lumisca/core/shared";
import { useLocale } from "../../i18n.ts";
import { formatClockTime } from "../../format.ts";
import { useCopy } from "../../hooks/useSave.ts";
import type { StellaEntry } from "../../types.ts";
import { ContentImages } from "../ContentImages.tsx";
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
 * stella-stream projection): text, the cards a `chat_ui` result carried,
 * and the files a `chat_attach` result sent. There is no work log and no
 * tool row to draw, because none ever arrives.
 */
export function StellaMessage({
  entry,
  author,
  showAvatar,
  visualBase,
  attachBase,
  onRewind,
  onSend,
}: {
  entry: StellaEntry;
  /** The conversation's agent (every non-user entry is its words). */
  author: MessageAuthor;
  /** False when the previous entry was the same speaker: a continuation
   * drops the repeated face and the gap above it. */
  showAvatar: boolean;
  /** Asset base of the conversation (see MarkdownBlock). */
  visualBase: string;
  /** Attachment base of the conversation (the files chat_attach sent). */
  attachBase: string;
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
    return <UserBubble entry={entry} onRewind={onRewind} time={time} />;
  }
  return (
    <AgentBubble
      entry={entry}
      author={author}
      showAvatar={showAvatar}
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
}: {
  entry: StellaEntry;
  onRewind: (timestamp: number, text: string) => void;
  time: ComponentChildren;
}) {
  const { copied, copy } = useCopy(entry.text);
  return (
    <div className="msg-user-wrap">
      <div className="msg user">
        <div className="msg-body">
          {entry.text && <p className="msg-user-text">{entry.text}</p>}
          {
            /* The pictures the user attached are part of what they said, so
              they sit inside the bubble, under its text. */
          }
          {entry.images.length > 0 && <ContentImages images={entry.images} />}
        </div>
      </div>
      <div className="msg-meta">
        {time}
        <button
          type="button"
          className="msg-action-btn"
          onClick={() => onRewind(entry.timestamp, entry.text)}
        >
          <IconArrowBackUp size={16} stroke={1.5} />
        </button>
        {entry.text && (
          <button
            type="button"
            className="msg-action-btn"
            onClick={() => void copy()}
          >
            {copied
              ? <IconCheck size={16} stroke={2} />
              : <IconClipboard size={16} stroke={1.5} />}
          </button>
        )}
      </div>
    </div>
  );
}

/** The agent's message: its face in the margin, the words on the sheet. */
function AgentBubble({
  entry,
  author,
  showAvatar,
  visualBase,
  attachBase,
  onSend,
  time,
}: {
  entry: StellaEntry;
  author: MessageAuthor;
  showAvatar: boolean;
  visualBase: string;
  attachBase: string;
  onSend: (text: string) => void;
  time: ComponentChildren;
}) {
  return (
    <div className={`stella-msg${showAvatar ? "" : " continued"}`}>
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
        <div className="stella-msg-body markdown">
          {entry.text && (
            <MarkdownBlock text={entry.text} visualBase={visualBase} />
          )}
          {entry.cards.map((markup, index) => (
            <CardView key={index} markup={markup} onSend={onSend} />
          ))}
          <AttachmentCard attachments={entry.attachments} base={attachBase} />
        </div>
        <div className="msg-meta start">{time}</div>
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
  const view = useMemo<UiView | null>(() => {
    const parsed = parseUiMarkup(markup);
    return parsed.ok ? parsed.view : null;
  }, [markup]);
  return <UiCard view={view} onSend={onSend} />;
}
