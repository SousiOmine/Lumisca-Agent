/**
 * The transcript as the model sees it.
 *
 * Three transformations sit between the conversation the user reads and the
 * messages a provider receives, and their order matters: the view starts at
 * the newest compaction checkpoint (everything before it stays in the
 * transcript, the database and the UI but is not sent — see
 * ai/context-compaction.ts), notifications become user messages carrying their
 * title + body (the prefix contract the system prompt teaches), and image
 * blocks become their analysis text when the main model cannot see images.
 */

import { contextStart } from "../ai/context-compaction.ts";
import { toLlmMessages } from "../ai/llm-view.ts";
import type {
  AgentMessage,
  ImageContent,
  Message,
  TextContent,
} from "../domain/message.ts";
import type { ImageAnalyzer } from "./image-analysis.ts";

export class SessionLlmView {
  constructor(
    /** The analyzer of a text-only main model, or null when the model sees
     * images itself (or no analysis model is configured). */
    private readonly imageAnalyzer: ImageAnalyzer | null,
  ) {}

  /** Convert the transcript for the LLM (see the module comment for the
   * three transformations and their order). */
  convert(messages: AgentMessage[]): Message[] | Promise<Message[]> {
    const start = contextStart(messages);
    const mapped = toLlmMessages(
      start === 0 ? messages : messages.slice(start),
    );
    return this.imageAnalyzer === null
      ? mapped
      : this.convertWithAnalysis(mapped);
  }

  /** Replace image blocks with their analysis text (the transcript itself
   * is never mutated, so the UI and the database keep the original
   * images). Called with the output of toLlmMessages, so every message is
   * already LLM-compatible. */
  private async convertWithAnalysis(messages: Message[]): Promise<Message[]> {
    const out: Message[] = [];
    for (const message of messages) {
      const content = message.content;
      if (
        typeof content === "string" ||
        !content.some((block) => block.type === "image")
      ) {
        out.push(message);
        continue;
      }
      const analyzed = await this.imageAnalyzer!.analyzeContent(
        content as Array<TextContent | ImageContent>,
      );
      out.push({ ...message, content: analyzed } as Message);
    }
    return out;
  }
}
