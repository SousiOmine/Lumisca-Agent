import { Fragment, useMemo } from "preact/compat";
import { useArrivals } from "../../hooks/useArrivals.ts";
import { useTranscriptScroll } from "../../hooks/useTranscriptScroll.ts";
import { useLocale, useT } from "../../i18n.ts";
import { formatDaySeparator, startOfDay } from "../../format.ts";
import { RunningIndicator } from "../chat/RunningIndicator.tsx";
import { entryKey, type StellaConversationState } from "../../stella-state.ts";
import { AgentAvatar } from "./AgentAvatar.tsx";
import { CardView } from "../chat/CardView.tsx";
import { type MessageAuthor, StellaMessage } from "./StellaMessage.tsx";

/**
 * A stella conversation: the user's words and the messages the agent sent,
 * one after another, with the day they were said under a separator — the
 * shape a message app has.
 *
 * There is no turn header, no work log, no tool row and no streaming reply,
 * because none of them is ever sent (see the server's stella-stream
 * projection): a message appears whole when its turn ends — the agent's
 * final text, or what it sent with `send_chat`. A run that says nothing (its
 * turn wrote the silence sentinel) therefore shows only the typing dots,
 * then nothing — this component cannot accidentally draw the agent's
 * narration.
 */
export function StellaTranscript({
  conversation,
  author,
  visualBase,
  attachBase,
  uploadBase,
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
  /** Attachment base of the conversation (the files send_chat sent). */
  attachBase: string;
  /** Where a prompt's own files are read back from: the machine, through the
   * conversation's upload route (their bytes live there, not in the
   * transcript). */
  uploadBase: string;
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

  // Which messages may animate in: only the ones that arrived at the live
  // edge of the conversation. The first paint draws the whole loaded window,
  // and paging back inserts history above the reader (see hooks/useArrivals) —
  // neither is an arrival. The keys are memoized: a stella conversation also
  // re-renders on tokens (the run's status), and entryKey rebuilds a string
  // per entry from its attachments and files.
  const keys = useMemo(
    () => conversation.entries.map((entry) => entryKey(entry)),
    [conversation.entries],
  );
  const entering = useArrivals(keys);

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
        {conversation.entries.length === 0 && !conversation.running && (
          <p className="stella-loading" role="status">
            {t("chat.stella.transcript.empty")}
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
          const key = entryKey(entry);
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
                entering={entering.has(key)}
                visualBase={visualBase}
                attachBase={attachBase}
                uploadBase={uploadBase}
                onRewind={onRewind}
                onSend={onSend}
              />
            </Fragment>
          );
        })}
        {conversation.liveCard !== null && (
          <CardView
            markup={conversation.liveCard.markup}
            streaming
            onSend={onSend}
          />
        )}
        {conversation.running && (
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
