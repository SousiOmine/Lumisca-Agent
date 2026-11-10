import { useMemo } from "preact/compat";
import { contentText, splitChatText } from "@lumisca/core/shared";
import type { AssistantMessage } from "../../types.ts";
import { CardView } from "./CardView.tsx";
import { MarkdownBlock } from "./MarkdownBlock.tsx";

/** The final assistant message of a turn (rendered under the work log).
 *
 * Its text may hold cards: each is drawn where the agent wrote it, between
 * the words around it (see shared/ui-markup/segments.ts). */
export function AssistantText(
  { message, visualBase, onCardSend }: {
    message: AssistantMessage;
    visualBase: string;
    onCardSend: (text: string) => void;
  },
) {
  const text = contentText(message.content);
  const segments = useMemo(() => splitChatText(text), [text]);
  return (
    <div className="msg">
      <div className="msg-body markdown">
        {segments.map((segment, index) =>
          segment.type === "card"
            ? (
              <CardView
                key={index}
                markup={segment.markup}
                onSend={onCardSend}
              />
            )
            : (
              <MarkdownBlock
                key={index}
                text={segment.text}
                visualBase={visualBase}
              />
            )
        )}
      </div>
    </div>
  );
}
