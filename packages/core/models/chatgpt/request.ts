/**
 * The request shape the ChatGPT (Codex) backend requires, declared as model
 * compat so the transport stays provider-agnostic.
 *
 * Its Responses endpoint is not the public one: it rejects a request whose
 * top-level `instructions` is missing, and it never stores conversation
 * state. The transport reads {@link CHATGPT_COMPAT.instructionsFallback} as
 * "this backend takes the system prompt out of `input` and into a required
 * `instructions` value, and keeps no server-side state", and
 * {@link CHATGPT_COMPAT.forceReasoning} as "these models are reasoning
 * models whatever their ids look like to the SDK".
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
};
