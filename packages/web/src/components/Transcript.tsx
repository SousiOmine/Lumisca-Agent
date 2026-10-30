import { useMemo } from "preact/compat";
import type { ComponentChildren } from "preact";
import type { AgentMessage, SessionView, ToolResultMessage } from "../types.ts";
import type { UserMessageImage } from "./chat/types.ts";
import { buildTurns, ConversationTurn } from "./chat/ConversationTurn.tsx";
import { ErrorBanner } from "./chat/ErrorBanner.tsx";
import { MarkdownBlock } from "./chat/MarkdownBlock.tsx";
import { useTranscriptScroll } from "../hooks/useTranscriptScroll.ts";

interface TranscriptProps {
  messages: AgentMessage[];
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

/** Code mode's scrolling transcript: turns, the streaming tail, the error
 * row, and the follow-the-bottom scroll. A stella conversation has its own
 * (components/stella/StellaTranscript.tsx): it receives different data, so
 * it is a different component rather than a flag here. */
export function Transcript(
  {
    messages,
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
  }: TranscriptProps,
) {
  const { scrollRef } = useTranscriptScroll();
  const turns = useMemo(() => buildTurns(messages), [messages]);
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
        {messages.length === 0 && streamingText.length === 0 && (
          <div className="chat-empty">
            <div className="chat-empty-inner">{empty}</div>
          </div>
        )}
        {turns.map((turn, index) => (
          <ConversationTurn
            key={`${turn.user.timestamp}-${index}`}
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
