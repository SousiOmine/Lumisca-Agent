import { useMemo, useRef } from "preact/compat";
import { messageKey } from "../events.ts";
import { useArrivals, withoutHandoff } from "../hooks/useArrivals.ts";
import { useT } from "../i18n.ts";
import type { ComponentChildren } from "preact";
import type { AgentMessage, SessionView, ToolResultMessage } from "../types.ts";
import type { ConversationTurnData, UserMessageImage } from "./chat/types.ts";
import { buildTurns, ConversationTurn } from "./chat/ConversationTurn.tsx";
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
  onSend?: (text: string) => void;
  /** Shown in the middle while the transcript is empty. */
  empty?: ComponentChildren;
}

/** Identity of one turn for the arrival diff: the message that started it
 * (a prompt, a notification) and where it sits. A turn has no id of its own;
 * the message keys the transcript already uses are the closest thing. */
function turnKey(turn: ConversationTurnData): string {
  return messageKey(turn.user);
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
    runningTools,
    running,
    agentEndedAt,
    error,
    visualBase,
    attachBase,
    onRewind,
    onSend,
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
  const turns = useMemo(() => buildTurns(messages), [messages]);
  // Which turns may animate in: only the ones that arrived at the live edge.
  // The first paint draws the loaded window and paging back inserts turns
  // above the reader — neither is an arrival (see hooks/useArrivals), and an
  // ungated animation staged the whole transcript on every open.
  const arrivals = useArrivals(turns.map((turn) => turnKey(turn)));
  // The answer that was streaming is the same answer the server then sends as
  // a message; replaying it once it settles would make every reply jump back
  // to its first line. The text is the identity (the stream is a prefix).
  const entering = withoutHandoff(
    arrivals,
    turns.map((turn) => ({
      key: turnKey(turn),
      text: lastAssistantText(turn),
    })),
    streamed.current,
  );
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
        {turns.map((turn, index) => (
          <ConversationTurn
            key={`${turn.user.timestamp}-${index}`}
            entering={entering.has(turnKey(turn))}
            turn={turn}
            toolResults={toolResults}
            runningTools={runningTools}
            visualBase={visualBase}
            attachBase={attachBase}
            running={running && index === turns.length - 1}
            endedAt={index === turns.length - 1 ? agentEndedAt : undefined}
            onRewind={onRewind}
            onSend={onSend ?? (() => {})}
          />
        ))}
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
