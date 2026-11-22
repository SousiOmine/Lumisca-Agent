/**
 * The text a stream produced, accumulated the one way every consumer reads
 * it.
 *
 * Three places assemble a turn's body from the same deltas — the transport's
 * `runStream`, the agent loop's `TurnStream` and the accumulate-text helper
 * `streamText` — and each of them also has to answer the same follow-up
 * question: what is the turn's text when the stream delivered no delta at
 * all? A cached or non-streaming provider path puts the answer in the
 * finished message instead. Both halves of that rule live here, so no caller
 * can disagree with another about which copy wins.
 */

import type { StreamEvent } from "./transport.ts";

export class StreamAccumulator {
  private streamedText = "";
  private streamedThinking = "";

  /** Take one event of the turn's stream. Events that carry no body
   * (start, tool calls, done) change nothing. */
  take(event: StreamEvent): void {
    if (event.type === "text_delta") this.streamedText += event.delta;
    else if (event.type === "thinking_delta") {
      this.streamedThinking += event.delta;
    }
  }

  /** The text the stream delivered, delta by delta. Empty when the provider
   * sent none (see {@link StreamAccumulator.textOf}). */
  get text(): string {
    return this.streamedText;
  }

  /** The thinking the stream delivered, delta by delta. */
  get thinking(): string {
    return this.streamedThinking;
  }

  /** The turn's text: the deltas the stream delivered, else the finished
   * message's own text — the copy a cached or non-streaming path carries. */
  textOf(finishedText: string | undefined): string {
    return this.streamedText.length > 0
      ? this.streamedText
      : (finishedText ?? "");
  }

  /** The turn's thinking, by the same rule as {@link
   * StreamAccumulator.textOf}. */
  thinkingOf(finishedThinking: string | undefined): string {
    return this.streamedThinking.length > 0
      ? this.streamedThinking
      : (finishedThinking ?? "");
  }
}
