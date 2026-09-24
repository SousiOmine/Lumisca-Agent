/** Frontend-safe shared helpers (see shared/mod.ts): pure functions and constants with no runtime dependencies, bundled into the browser client. */
import type { AgentMessage, LlmMessage } from "../ai/types.ts";

/*
 * Token estimation for history that has no provider-reported usage to lean
 * on. The context compactor (agent/context-compaction.ts) measures a
 * request from the newest assistant `usage` — the provider's own count —
 * and only has to *estimate* what was appended after it, so the figures here
 * are deltas, never the whole conversation. The same estimate prices a
 * message the UI would show before any turn reported usage.
 *
 * The estimate is deliberately one fixed heuristic rather than a provider
 * tokenizer: it must be computable offline, deterministic across processes,
 * and identical for every consumer (the DeepSeek Harness's `ctx.tokenMeter`
 * makes the same trade — four characters per token plus structural
 * overhead, with the provider's reported usage as the anchor).
 */

/** Characters one token covers in ASCII/Latin text. */
const ASCII_CHARS_PER_TOKEN = 4;

/** Structural overhead of one content block: delimiters and markers the
 * provider serializes around the text (`{"type":"text","text":"…"}`). */
const BLOCK_OVERHEAD_TOKENS = 4;

/** Structural overhead of one message: role markers, separators, and the
 * tool-call/result envelope. */
const MESSAGE_OVERHEAD_TOKENS = 8;

/** Tokens charged for one image block. The base64 payload is not text the
 * model reads, so counting its characters would overestimate a screenshot
 * by orders of magnitude; providers bill a visual budget per image
 * instead, which this fixed figure approximates. */
export const IMAGE_TOKEN_ESTIMATE = 1200;

/**
 * Estimated tokens of one text: ASCII characters are priced at four per
 * token, everything else at one token per character.
 *
 * The non-ASCII rate is the deliberate upper end of what tokenizers do to
 * Japanese (between roughly 0.7 and 1.0 tokens per character), so the
 * estimate errs toward compacting slightly early — the direction that
 * cannot overflow a request.
 */
export function estimateTextTokens(text: string): number {
  if (text.length === 0) return 0;
  let ascii = 0;
  let wide = 0;
  for (const char of text) {
    if (char.codePointAt(0)! <= 0x7f) ascii++;
    else wide++;
  }
  return Math.ceil(ascii / ASCII_CHARS_PER_TOKEN) + wide;
}

/** Estimated tokens of a message's content array (text and images). */
function estimateContentTokens(
  content: string | readonly { type: string; text?: string }[],
): number {
  if (typeof content === "string") return estimateTextTokens(content);
  let tokens = 0;
  for (const block of content) {
    switch (block.type) {
      case "text":
        tokens += estimateTextTokens(block.text ?? "") + BLOCK_OVERHEAD_TOKENS;
        break;
      case "image":
        tokens += IMAGE_TOKEN_ESTIMATE + BLOCK_OVERHEAD_TOKENS;
        break;
      default:
        break;
    }
  }
  return tokens;
}

/** JSON of a tool call's arguments (never throws: an unserializable value
 * is priced as its string form). */
function argumentsText(args: unknown): string {
  try {
    return JSON.stringify(args) ?? "";
  } catch {
    return String(args);
  }
}

/**
 * Estimated tokens of one transcript message, including the structural
 * overhead its role adds to a request. Every role of {@link AgentMessage}
 * is priced as the model receives it: notification/context/checkpoint
 * messages cost their model-facing text, a mode message its full prompt.
 */
export function estimateMessageTokens(message: AgentMessage): number {
  switch (message.role) {
    case "user":
      return estimateContentTokens(message.content) + MESSAGE_OVERHEAD_TOKENS;
    case "assistant": {
      let tokens = MESSAGE_OVERHEAD_TOKENS;
      for (const block of message.content) {
        if (block.type === "text") {
          tokens += estimateTextTokens(block.text) + BLOCK_OVERHEAD_TOKENS;
        } else if (block.type === "thinking") {
          // Reasoning blocks are not sent back in most provider protocols;
          // pricing them would overstate the request.
          continue;
        } else {
          tokens += estimateTextTokens(block.name) +
            estimateTextTokens(argumentsText(block.arguments)) +
            BLOCK_OVERHEAD_TOKENS;
        }
      }
      return tokens;
    }
    case "toolResult":
      return estimateContentTokens(message.content) +
        estimateTextTokens(message.toolName) + MESSAGE_OVERHEAD_TOKENS;
    case "mode":
      return estimateTextTokens(message.fullPrompt) + MESSAGE_OVERHEAD_TOKENS;
    case "notification":
      return estimateTextTokens(message.title) +
        estimateTextTokens(message.body) + MESSAGE_OVERHEAD_TOKENS;
    case "context":
    case "checkpoint":
      return estimateTextTokens(message.body) + MESSAGE_OVERHEAD_TOKENS;
  }
}

/** Estimated tokens of a transcript (the sum of {@link estimateMessageTokens}). */
export function estimateMessagesTokens(
  messages: readonly AgentMessage[],
): number {
  let tokens = 0;
  for (const message of messages) tokens += estimateMessageTokens(message);
  return tokens;
}

/**
 * Estimated tokens of one message as the transport sends it (see
 * ai/types.ts LlmMessage). The request clamp (ai/stream.ts) prices a
 * converted request with this, so it counts what the provider actually
 * receives: reasoning blocks are skipped for the same reason as in
 * {@link estimateMessageTokens}.
 */
export function estimateLlmMessageTokens(message: LlmMessage): number {
  const overhead = MESSAGE_OVERHEAD_TOKENS;
  if (typeof message.content === "string") {
    return overhead + estimateTextTokens(message.content);
  }
  let tokens = overhead;
  for (const block of message.content) {
    switch (block.type) {
      case "text":
        tokens += estimateTextTokens(block.text) + BLOCK_OVERHEAD_TOKENS;
        break;
      case "image":
        tokens += IMAGE_TOKEN_ESTIMATE + BLOCK_OVERHEAD_TOKENS;
        break;
      case "toolCall":
        tokens += estimateTextTokens(block.name) +
          estimateTextTokens(argumentsText(block.arguments)) +
          BLOCK_OVERHEAD_TOKENS;
        break;
      default:
        // Reasoning blocks are not sent back in most provider protocols.
        break;
    }
  }
  return tokens;
}

/** Estimated tokens of a converted request's messages. */
export function estimateLlmMessagesTokens(
  messages: readonly LlmMessage[],
): number {
  let tokens = 0;
  for (const message of messages) tokens += estimateLlmMessageTokens(message);
  return tokens;
}

/** Estimated tokens of one tool definition: its name, description, and
 * JSON Schema. Tool definitions sit in front of the messages on every
 * request, so the compactor prices them when no provider usage anchors the
 * envelope yet. */
export function estimateToolTokens(tool: {
  name: string;
  description: string;
  parameters: unknown;
}): number {
  return estimateTextTokens(tool.name) +
    estimateTextTokens(tool.description) +
    estimateTextTokens(argumentsText(tool.parameters)) +
    MESSAGE_OVERHEAD_TOKENS;
}
