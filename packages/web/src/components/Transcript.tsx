import { useMemo, useRef } from "preact/compat";
import { messageKey } from "../events.ts";
import { useArrivals, withoutHandoff } from "../hooks/useArrivals.ts";
import { useT } from "../i18n.ts";
import type { ComponentChildren } from "preact";
import type { AgentMessage, SessionView, ToolResultMessage } from "../types.ts";
import type { ConversationTurnData, UserMessageImage } from "./chat/types.ts";
import { buildTurns, ConversationTurn } from "./chat/ConversationTurn.tsx";
import { CardView } from "./chat/CardView.tsx";
import { ErrorBanner } from "./chat/ErrorBanner.tsx";
import { MarkdownBlock } from "./chat/MarkdownBlock.tsx";
import { useTranscriptScroll } from "../hooks/useTranscriptScroll.ts";

interface TranscriptProps {
  messages: AgentMessage[];
  /** Read the history before the loaded window (the reader reached the
   * top). Returns whether a read started. */
  onLoadOlder: () => boolean;
  /** Whether the server said history exists before this window (a null
   * cursor means the transcript's beginning). */
  hasOlder: boolean;
  /** Whether a read started by onLoadOlder is still in flight. */
  loadingOlder: boolean;
  /** Bumped by the view on submit; the transcript owns the scroll element,
   * so the "jump to the newest message" intent has to arrive here (see
   * useTranscriptScroll's pinToken). */
  pinToken?: number;
  streamingText: string;
  /** The card a `chat_attach` call is writing right now, or null. */
  liveCard: { toolCallId: string; markup: string } | null;
  runningTools: SessionView["runningTools"];
  /** True while a run is active (the last turn then renders as running). */
  running: boolean;
  agentEndedAt?: number;
  error?: string;
  /** Resolves a `visual:` image reference (see api-client). */
  visualBase: string;
  /** Resolves a file `chat_attach` sent (see api-client). */
  attachBase: string;
  onRewind: (
    timestamp: number,
    text: string,
    images: UserMessageImage[],
  ) => Promise<void>;
  /** Sends a card's answer as the next prompt (a card ends its turn). */
  onCardSend: (text: string) => void;
  /** Shown in the middle while the transcript is empty. */
  empty?: ComponentChildren;
}

/** Identity of one turn for the arrival diff: the message that started it
 * (a prompt, a notification) and where it sits. A turn has no id of its own;
 * the message keys the transcript already uses are the closest thing. A
 * fragment (a turn whose prompt is on an earlier page) is named by its first
 * row instead, which is unique for the same reason. */
function turnKey(turn: ConversationTurnData): string {
  const first = turn.user ?? turn.responses[0];
  return first === undefined ? "" : messageKey(first);
}

/** The last thing the agent said in a turn: what the streaming tail would
 * have become when the run ends, so the handoff can be recognised (see
 * withoutHandoff). */
function lastAssistantText(turn: ConversationTurnData): string {
  for (let i = turn.responses.length - 1; i >= 0; i--) {
    const message = turn.responses[i];
    if (message?.role !== "assistant") continue;
    const block = message.content.find((part) => part.type === "text");
    return block?.type === "text" ? block.text : "";
  }
  return "";
}

/** Code mode's scrolling transcript: turns, the streaming tail, the error
 * row, and the follow-the-bottom scroll. A stella conversation has its own
 * (components/stella/StellaTranscript.tsx): it receives different data, so
 * it is a different component rather than a flag here. */
export function Transcript(
  {
    messages,
    onLoadOlder,
    loadingOlder,
    hasOlder,
    streamingText,
    liveCard,
    runningTools,
    running,
    agentEndedAt,
    error,
    visualBase,
    attachBase,
    onRewind,
    onCardSend,
    empty,
    pinToken,
  }: TranscriptProps,
) {
  // The transcript holds a WINDOW of the session's history (see the core's
  // session/transcript-window.ts): reaching the top reads the page before it
  // and keeps the line the reader was on.
  const t = useT();
  /** The streamed reply as of the previous commit (see the handoff above). */
  const streamed = useRef(streamingText);
  const { scrollRef } = useTranscriptScroll({
    onReachTop: () => hasOlder && onLoadOlder(),
    loadingOlder,
    firstMessageKey: messages[0] === undefined
      ? undefined
      : messageKey(messages[0]),
    pinToken,
  });
  // The rows this transcript draws and diffs, built once per history change:
  // a streamed token re-renders the component on every frame, and neither a
  // turn's key (a message key, built from its first message each time) nor
  // the scan for the last thing the agent said in it can change while a token
  // arrives. The render loop reads the key from here too, so it is built once
  // per turn rather than once per turn and frame.
  const { rows, turnKeys } = useMemo(() => {
    const rows = buildTurns(messages).map((turn) => ({
      turn,
      key: turnKey(turn),
      text: lastAssistantText(turn),
    }));
    return { rows, turnKeys: rows.map((row) => row.key) };
  }, [messages]);
  // Which turns may animate in: only the ones that arrived at the live edge.
  // The first paint draws the loaded window and paging back inserts turns
  // above the reader — neither is an arrival (see hooks/useArrivals), and an
  // ungated animation staged the whole transcript on every open.
  const arrivals = useArrivals(turnKeys);
  // The answer that was streaming is the same answer the server then sends as
  // a message; replaying it once it settles would make every reply jump back
  // to its first line. The text is the identity (the stream is a prefix).
  // Not memoized: `streamed` is a ref (writing it during render is how the
  // handoff reads the previous commit's text), so a memo would freeze the
  // decision on a value React does not watch. It costs nothing per token
  // either — with no arrival in flight it returns the set it was given.
  const entering = withoutHandoff(arrivals, rows, streamed.current);
  streamed.current = streamingText;
  const toolResults = useMemo(() => {
    const map = new Map<string, ToolResultMessage>();
    for (const message of messages) {
      if (message.role === "toolResult") map.set(message.toolCallId, message);
    }
    return map;
  }, [messages]);

  return (
    <div className="chat-scroll" ref={scrollRef}>
      <div className="chat-column">
        {loadingOlder && (
          <p className="chat-history-note" role="status">
            {t("chat.history.loadingOlder")}
          </p>
        )}
        {messages.length === 0 && streamingText.length === 0 && (
          <div className="chat-empty">
            <div className="chat-empty-inner">{empty}</div>
          </div>
        )}
        {rows.map(({ turn, key }, index) => (
          <ConversationTurn
            key={`${key}-${index}`}
            entering={entering.has(key)}
            turn={turn}
            toolResults={toolResults}
            runningTools={runningTools}
            visualBase={visualBase}
            attachBase={attachBase}
            running={running && index === rows.length - 1}
            endedAt={index === rows.length - 1 ? agentEndedAt : undefined}
            onRewind={onRewind}
            onCardSend={onCardSend}
          />
        ))}
        {liveCard !== null && (
          <CardView markup={liveCard.markup} streaming onSend={onCardSend} />
        )}
        {streamingText.length > 0 && (
          <div className="msg">
            <div className="msg-body markdown">
              <MarkdownBlock text={streamingText} visualBase={visualBase} />
              <span className="cursor" />
            </div>
          </div>
        )}
        {error && <ErrorBanner text={error} />}
      </div>
    </div>
  );
}
