/**
 * The pure model vocabulary: what a provider is addressed through and what
 * a caller may assume about it. This module knows no transport, no provider
 * implementation and no storage; those live in ai/ and models/.
 */

export type Api =
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages"
  | "google-generative-ai"
  | "google-vertex"
  | "mistral-conversations"
  | "azure-openai-responses"
  | "bedrock-converse-stream"
  | string;
