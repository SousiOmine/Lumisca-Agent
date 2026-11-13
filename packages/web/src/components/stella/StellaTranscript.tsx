import { Fragment, useMemo } from "preact/compat";
import { formatDaySeparator, startOfDay } from "../../format.ts";
import { useArrivals } from "../../hooks/useArrivals.ts";
import { useTranscriptScroll } from "../../hooks/useTranscriptScroll.ts";
import { useLocale, useT } from "../../i18n.ts";
import {
  entryKey,
  type StellaConversationState,
  transcriptEntries,
} from "../../stella-state.ts";
import { CardView } from "../chat/CardView.tsx";
import { RunningIndicator } from "../chat/RunningIndicator.tsx";
import { AgentAvatar } from "./AgentAvatar.tsx";
import { EnvRequestCard } from "./EnvRequestCard.tsx";
import { ShareRequestCard } from "./ShareRequestCard.tsx";
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
  onProvideEnv,
  onDeclineEnv,
  onPickShare,
  onDeclineShare,
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
  /** The user entered the value `vm_env` asked for. The card that asks is
   * drawn here rather than over the window: the request is a turn of the
   * conversation (see EnvRequestCard). */
  onProvideEnv: (value: string, toolCallId: string) => Promise<void>;
  /** The user refused to give the value. */
  onDeclineEnv: (toolCallId: string) => Promise<void>;
  /** Open the folder dialog (the card's button). It is the view's one sheet,
   * not a child of the transcript. */
  onPickShare: () => void;
  /** The user refused to lend one. */
  onDeclineShare: (toolCallId: string) => Promise<void>;
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
  // The prompt a routine ran is not drawn (see transcriptEntries). Everything
  // below derives from the drawn list, not from the state: a hidden row would
  // otherwise open a day separator above nothing, break the avatar runs, and
  // give the scroll anchor a key that is not in the document.
  const entries = useMemo(
    () => transcriptEntries(conversation.entries),
    [conversation.entries],
  );
  const first = entries[0];
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
    () => entries.map((entry) => entryKey(entry)),
    [entries],
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
        {entries.length === 0 && !conversation.running && (
          <p className="stella-loading" role="status">
            {t("chat.stella.transcript.empty")}
          </p>
        )}
        {entries.map((entry, index) => {
          const day = startOfDay(entry.timestamp);
          const newDay = day !== previousDay;
          previousDay = day;
          const previous = entries[index - 1];
          // A run of the agent's messages reads as one answer: the face and
          // the gap belong to the first of the run only.
          const showAvatar =
            entry.role !== "user" &&
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
        {/* The question the run is blocked on, at the live edge where the
         * answer belongs. It takes the agent's face and column like a
         * message: the agent is the one asking. */}
        {conversation.envRequest !== null && (
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
              <EnvRequestCard
                // A different request is a different field: without this,
                // a resync that replaces one request with another would keep
                // the value typed for the first.
                key={conversation.envRequest.toolCallId}
                request={conversation.envRequest}
                onProvide={onProvideEnv}
                onDecline={onDeclineEnv}
              />
              {/* The sheet announced itself (a dialog takes the attention);
               * a card does not, so the request says its sentence once for
               * a screen reader. Silent otherwise: the same sentence is
               * written in the card right beside it. */}
              <span className="visually-hidden" role="status">
                {t("chat.stella.env.request", {
                  name: conversation.envRequest.name,
                })}
              </span>
            </div>
          </div>
        )}
        {/* The agent wants a folder from this computer. Like the env card it
         * takes the agent's face and column: the agent is the one asking. */}
        {conversation.shareRequest?.kind === "lend" && (
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
              <ShareRequestCard
                key={conversation.shareRequest.toolCallId}
                request={conversation.shareRequest}
                onPick={onPickShare}
                onDecline={onDeclineShare}
              />
              <span className="visually-hidden" role="status">
                {t("chat.stella.share.request.announce")}
              </span>
            </div>
          </div>
        )}
        {/* The dots say "the agent is composing". While the run waits for
         * the user it is not composing but blocked, and the card above says
         * so — two opposite signals in one column would read as a stuck
         * run. */}
        {conversation.running &&
          conversation.envRequest === null &&
          conversation.shareRequest?.kind !== "lend" && (
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
          <p className="error-text" role="alert">
            {conversation.error}
          </p>
        )}
      </div>
    </div>
  );
}
