import { Fragment } from "preact/compat";
import { useTranscriptScroll } from "../../hooks/useTranscriptScroll.ts";
import { useLocale, useT } from "../../i18n.ts";
import { formatDaySeparator, startOfDay } from "../../format.ts";
import { RunningIndicator } from "../chat/RunningIndicator.tsx";
import { MarkdownBlock } from "../chat/MarkdownBlock.tsx";
import { entryKey, type StellaConversationState } from "../../stella-state.ts";
import { AgentAvatar } from "./AgentAvatar.tsx";
import { type MessageAuthor, StellaMessage } from "./StellaMessage.tsx";

/**
 * A stella conversation: the user's words and the agent's words, one after
 * another, with the day they were said under a separator — the shape a
 * message app has.
 *
 * There is no turn header, no work log and no tool row, because none of them
 * is ever sent (see the server's stella-stream projection) — this component
 * cannot accidentally draw what the agent did to arrive at its answer.
 *
 * A `chat_attach` result is the exception on the server side, and only
 * because it IS part of the reply: the files an agent sends are something to
 * look at or keep, so they arrive as an entry of their own and are drawn as
 * the same card code mode uses.
 */
export function StellaTranscript({
  conversation,
  author,
  visualBase,
  attachBase,
  onRewind,
  onSend,
  onLoadOlder,
  loadingOlder,
  pinToken,
}: {
  conversation: StellaConversationState;
  /** The agent the conversation is with (its face and name). */
  author: MessageAuthor;
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
  const locale = useLocale();
  const first = conversation.entries[0];
  const { scrollRef } = useTranscriptScroll({
    onReachTop: () => conversation.older !== null && onLoadOlder(),
    loadingOlder,
    firstMessageKey: first === undefined ? undefined : entryKey(first),
    pinToken,
  });

  // The separators are derived, not stored: the day an entry belongs to is
  // a fact about its timestamp, so a re-render (a language switch, a new
  // entry) never leaves a stale label behind. Only an entry that falls on a
  // different day than the one before it opens a separator.
  let previousDay: number | null = null;

  return (
    <div className="chat-scroll" ref={scrollRef}>
      <div className="chat-column stella-column">
        {loadingOlder && (
          <p className="chat-history-note" role="status">
            {t("chat.history.loadingOlder")}
          </p>
        )}
        {conversation.entries.map((entry, index) => {
          const day = startOfDay(entry.timestamp);
          const newDay = day !== previousDay;
          previousDay = day;
          const previous = conversation.entries[index - 1];
          // A run of the agent's messages reads as one answer: the face and
          // the gap belong to the first of the run only.
          const showAvatar = entry.role !== "user" &&
            (newDay || previous === undefined || previous.role === "user");
          return (
            <Fragment key={`${entry.role}-${entry.timestamp}-${index}`}>
              {newDay && (
                <div className="stella-day" role="separator">
                  <span>{formatDaySeparator(entry.timestamp, locale)}</span>
                </div>
              )}
              <StellaMessage
                entry={entry}
                author={author}
                showAvatar={showAvatar}
                visualBase={visualBase}
                attachBase={attachBase}
                onRewind={onRewind}
                onSend={onSend}
              />
            </Fragment>
          );
        })}
        {conversation.streamingText.length > 0 && (
          <div className="stella-msg">
            <div className="stella-msg-avatar" aria-hidden="true">
              <AgentAvatar
                agentId={author.id}
                name={author.name}
                icon={author.icon}
                size={26}
              />
            </div>
            <div className="stella-msg-main">
              <div className="stella-msg-body markdown">
                <MarkdownBlock
                  text={conversation.streamingText}
                  visualBase={visualBase}
                />
                <span className="cursor" />
              </div>
            </div>
          </div>
        )}
        {conversation.running && conversation.streamingText.length === 0 && (
          <RunningIndicator
            avatar={
              <AgentAvatar
                agentId={author.id}
                name={author.name}
                icon={author.icon}
                size={26}
              />
            }
          />
        )}
        {conversation.error !== undefined && (
          <p className="error-text" role="alert">{conversation.error}</p>
        )}
      </div>
    </div>
  );
}
