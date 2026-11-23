/**
 * The request shape the ChatGPT plan flow requires, declared as model
 * compat so the transport stays provider-agnostic.
 *
 * The public Responses API takes the system prompt in `instructions` and
 * requires `store:false`; it also rejects `max_output_tokens`, so the
 * transport must leave the completion cap out. The transport reads
 * {@link CHATGPT_COMPAT.instructionsFallback} as "this backend takes the
 * system prompt out of `input` and into a required `instructions` value, and
 * keeps no server-side state", {@link CHATGPT_COMPAT.forceReasoning} as
 * "these models are reasoning models whatever their ids look like to the
 * SDK", and {@link CHATGPT_COMPAT.omitMaxOutputTokens} as "do not send the
 * completion cap".
 */

import type { ModelCompat } from "../../ai/catalog.ts";

/** Instructions sent when a call has no system prompt: the backend rejects a
 * request without a top-level `instructions` value, and not every auxiliary
 * call carries a system prompt. */
export const CHATGPT_FALLBACK_INSTRUCTIONS = "You are a helpful assistant.";

/** The compat entry every ChatGPT model carries (see models/chatgpt/catalog.ts). */
export const CHATGPT_COMPAT: ModelCompat = {
  forceReasoning: true,
  instructionsFallback: CHATGPT_FALLBACK_INSTRUCTIONS,
  omitMaxOutputTokens: true,
};
