/**
 * Message assembly: what a prompt and a turn become in the transcript, and
 * the stamp that keeps them in the order they were appended.
 *
 * Kept out of agent.ts (the run and its loop) because these are the shapes a
 * caller reads: what a prompt becomes, and the identity a client finds it by.
 * The assistant messages a run builds are in ai/message-factory.ts.
 */

import type { AgentMessage, ImageContent } from "../domain/message.ts";

/** The timestamp of the next message an agent appends. Strictly increasing,
 * so the transcript's order is also its timestamp order: the clients keep a
 * window of the transcript, identify messages by role + timestamp and drop a
 * live message older than their newest one (see web's applyMessage), while the
 * window merge anchors on those identities.
 *
 * The clock alone is not enough. A prompt-side message and the context
 * snapshots published just before it can share a millisecond, and the
 * transport stamps the assistant message when the stream finalizes —
 * sometimes BEFORE the tool results it just produced. Inheriting the
 * previous message's stamp fixes both without inventing a virtual clock:
 * the transcript already knows the order it wants. */
export function nextTranscriptTimestamp(
  messages: readonly AgentMessage[],
): number {
  const previous = messages.at(-1)?.timestamp ?? 0;
  return Math.max(Date.now(), previous + 1);
}

/** Normalize a prompt input into a transcript message. */
export function normalizeInput(
  input: string | AgentMessage,
  images?: ImageContent[],
): AgentMessage {
  if (typeof input !== "string") return input;
  const content: Array<{ type: "text"; text: string } | ImageContent> = [
    { type: "text", text: input },
  ];
  if (images !== undefined && images.length > 0) content.push(...images);
  return { role: "user", content, timestamp: Date.now() } as AgentMessage;
}
