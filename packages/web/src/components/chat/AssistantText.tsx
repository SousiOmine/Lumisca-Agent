import { contentText, segmentsText, splitChatText } from "@lumisca/core/shared";
import { useMemo } from "preact/hooks";
import type { AssistantMessage } from "../../types.ts";
import { MessageCopyButton } from "./MessageCopyButton.tsx";
import { SegmentView } from "./SegmentView.tsx";

/** The final assistant message of a turn (rendered under the work log).
 *
 * Its text may hold cards: each is drawn where the agent wrote it, between
 * the words around it (see shared/chat-ui/segments.ts).
 *
 * The row under it is the answer's action, the same one stella's answer
 * carries (components/stella/StellaMessage.tsx): the prose is what a reader
 * takes away — a command, a path, a paragraph. What is copied is the prose
 * alone, without the cards' markup, which is how the conversation is written
 * rather than something the agent said (see segmentsText). */
export function AssistantText({
  message,
  visualBase,
  onCardSend,
}: {
  message: AssistantMessage;
  visualBase: string;
  onCardSend: (text: string) => void;
}) {
  const text = contentText(message.content);
  const segments = useMemo(() => splitChatText(text), [text]);
  const prose = useMemo(() => segmentsText(segments), [segments]);
  return (
    <div className="msg">
      <div className="msg-body markdown">
        {segments.map((segment, index) => (
          <SegmentView
            key={index}
            segment={segment}
            onSend={onCardSend}
            visualBase={visualBase}
          />
        ))}
      </div>
      {/* Nothing to copy when the reply is only a card: its text is markup
          the app reads, not words the agent addressed to the reader. */}
      {prose.length > 0 && (
        <div className="msg-meta start">
          <MessageCopyButton text={prose} rest />
        </div>
      )}
    </div>
  );
}
