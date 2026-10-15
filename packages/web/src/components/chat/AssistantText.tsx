import { contentText } from "@lumisca/core/shared";
import type { AssistantMessage } from "../../types.ts";
import { MarkdownBlock } from "./MarkdownBlock.tsx";

/** The final assistant message of a turn (rendered under the work log). */
export function AssistantText(
  { message, visualBase }: { message: AssistantMessage; visualBase: string },
) {
  return (
    <div className="msg">
      <div className="msg-body markdown">
        <MarkdownBlock
          text={contentText(message.content)}
          visualBase={visualBase}
        />
      </div>
    </div>
  );
}
