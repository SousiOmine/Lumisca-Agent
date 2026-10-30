import { useMemo } from "preact/compat";
import { parseUiMarkup, type UiView } from "@lumisca/core/shared";
import { useTranscriptScroll } from "../../hooks/useTranscriptScroll.ts";
import { MarkdownBlock } from "../chat/MarkdownBlock.tsx";
import { UiCard } from "../chat/UiCard.tsx";
import { CopyableUserMessage } from "../chat/CopyableUserMessage.tsx";
import { RunningIndicator } from "../chat/RunningIndicator.tsx";
import type { StellaEntry } from "../../types.ts";
import type { StellaConversationState } from "../../stella-state.ts";

/**
 * A stella conversation: the user's words and the agent's words.
 *
 * There is no turn header, no work log and no tool row, because none of them
 * is ever sent (see the server's stella-stream projection) — this component
 * cannot accidentally draw what the agent did to arrive at its answer. What
 * it draws is one entry after another, each with its own time, plus the reply
 * that is still streaming.
 */
export function StellaTranscript({
  conversation,
  visualBase,
  onRewind,
  onSend,
}: {
  conversation: StellaConversationState;
  /** Asset base of the conversation (see MarkdownBlock). */
  visualBase: string;
  /** Rewind from an entry onward (the entry's timestamp names it). */
  onRewind: (timestamp: number, text: string) => void;
  /** Send a card's answer as the user's next message. */
  onSend: (text: string) => void;
}) {
  const { scrollRef } = useTranscriptScroll();

  return (
    <div className="chat-scroll" ref={scrollRef}>
      <div className="chat-column">
        {conversation.entries.map((entry, index) => (
          <EntryRow
            key={`${entry.role}-${entry.timestamp}-${index}`}
            entry={entry}
            visualBase={visualBase}
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
 * agent's text and cards. */
function EntryRow({
  entry,
  visualBase,
  onRewind,
  onSend,
}: {
  entry: StellaEntry;
  visualBase: string;
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
