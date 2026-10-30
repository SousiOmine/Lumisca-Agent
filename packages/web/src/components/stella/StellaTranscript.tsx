import { useMemo } from "preact/compat";
import { parseUiMarkup, type UiView } from "@lumisca/core/shared";
import { useTranscriptScroll } from "../../hooks/useTranscriptScroll.ts";
import { useT } from "../../i18n.ts";
import { AttachmentCard } from "../chat/AttachmentCard.tsx";
import { MarkdownBlock } from "../chat/MarkdownBlock.tsx";
import { UiCard } from "../chat/UiCard.tsx";
import { CopyableUserMessage } from "../chat/CopyableUserMessage.tsx";
import { RunningIndicator } from "../chat/RunningIndicator.tsx";
import type { StellaEntry } from "../../types.ts";
import { entryKey, type StellaConversationState } from "../../stella-state.ts";

/**
 * A stella conversation: the user's words and the agent's words.
 *
 * There is no turn header, no work log and no tool row, because none of them
 * is ever sent (see the server's stella-stream projection) — this component
 * cannot accidentally draw what the agent did to arrive at its answer. What
 * it draws is one entry after another, each with its own time, plus the reply
 * that is still streaming.
 *
 * A `chat_attach` result is the exception on the server side, and only
 * because it IS part of the reply: the files an agent sends are something to
 * look at or keep, so they arrive as an entry of their own and are drawn as
 * the same card code mode uses.
 */
export function StellaTranscript({
  conversation,
  visualBase,
  attachBase,
  onRewind,
  onSend,
  onLoadOlder,
  loadingOlder,
  pinToken,
}: {
  conversation: StellaConversationState;
  /** Asset base of the conversation (see MarkdownBlock). */
  visualBase: string;
  /** Attachment base of the conversation (the files chat_attach sent). */
  attachBase: string;
  /** Rewind from an entry onward (the entry's timestamp names it). */
  onRewind: (timestamp: number, text: string) => void;
  /** Send a card's answer as the user's next message. */
  onSend: (text: string) => void;
  /** Read the entries before the loaded window (the reader reached the
   * top). Returns whether a read started. */
  onLoadOlder: () => boolean;
  /** Whether that read is still in flight. */
  loadingOlder: boolean;
  /** Bumped on submit: this component owns the scroll element, so the jump
   * to the newest entry has to arrive as a prop (see useTranscriptScroll's
   * pinToken). */
  pinToken?: number;
}) {
  // The transcript holds a WINDOW of the conversation (see the core's
  // session/transcript-window.ts): reaching the top reads the page before it
  // and keeps the entry the reader was looking at in place.
  const t = useT();
  const first = conversation.entries[0];
  const { scrollRef } = useTranscriptScroll({
    onReachTop: () => conversation.older !== null && onLoadOlder(),
    loadingOlder,
    firstMessageKey: first === undefined ? undefined : entryKey(first),
    pinToken,
  });

  return (
    <div className="chat-scroll" ref={scrollRef}>
      <div className="chat-column">
        {loadingOlder && (
          <p className="chat-history-note" role="status">
            {t("chat.history.loadingOlder")}
          </p>
        )}
        {conversation.entries.map((entry, index) => (
          <EntryRow
            key={`${entry.role}-${entry.timestamp}-${index}`}
            entry={entry}
            visualBase={visualBase}
            attachBase={attachBase}
            onRewind={onRewind}
            onSend={onSend}
          />
        ))}
        {conversation.streamingText.length > 0 && (
          <div className="msg">
            <div className="msg-body markdown">
              <MarkdownBlock
                text={conversation.streamingText}
                visualBase={visualBase}
              />
              <span className="cursor" />
            </div>
          </div>
        )}
        {conversation.running && conversation.streamingText.length === 0 && (
          <RunningIndicator />
        )}
        {conversation.error !== undefined && (
          <p className="error-text" role="alert">{conversation.error}</p>
        )}
      </div>
    </div>
  );
}

/** One entry: the user's message (with rewind and a copy button) or the
 * agent's text, cards and files. */
function EntryRow({
  entry,
  visualBase,
  attachBase,
  onRewind,
  onSend,
}: {
  entry: StellaEntry;
  visualBase: string;
  attachBase: string;
  onRewind: (timestamp: number, text: string) => void;
  onSend: (text: string) => void;
}) {
  if (entry.role === "user") {
    // The same bubble code mode uses: one action row (rewind, copy) whose
    // look and keyboard behaviour are already decided there.
    return (
      <CopyableUserMessage
        text={entry.text}
        images={[]}
        timestamp={entry.timestamp}
        onRewind={(timestamp, text) => onRewind(timestamp, text)}
      />
    );
  }
  return (
    <div className="msg">
      <div className="msg-body markdown">
        {entry.text && (
          <MarkdownBlock text={entry.text} visualBase={visualBase} />
        )}
        {entry.cards.map((markup, index) => (
          <CardView key={index} markup={markup} onSend={onSend} />
        ))}
        <AttachmentCard attachments={entry.attachments} base={attachBase} />
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
