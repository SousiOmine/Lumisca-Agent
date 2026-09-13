import { IconArrowsMinimize } from "@tabler/icons-preact";
import type { CheckpointMessage } from "../types.ts";
import { SystemRow } from "./SystemRow.tsx";

/** A compaction checkpoint (older history condensed to free context)
 * rendered as a compact one-line row; the model-facing summary expands on
 * click. It sits where the replaced messages were, so the transcript reads
 * "checkpoint → retained recent messages" — the same shape the model sees. */
export function CheckpointRow({ message }: { message: CheckpointMessage }) {
  return (
    <SystemRow
      title={message.title}
      body={message.body}
      status="neutral"
      icon={<IconArrowsMinimize size={13} />}
    />
  );
}
