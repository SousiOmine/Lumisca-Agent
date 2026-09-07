/**
 * Resolve a Lumisca {@link Model} (plus a resolved api key) into a Vercel AI
 * SDK language model. This is the single place where the provider→factory
 * mapping lives: the app's provider/model catalog stays Lumisca-typed, and
 * every actual request goes out through a Vercel {@link LanguageModel}.
 *
 * Api keys are injected from the credential store (or a provider's env-var
 * auth), so the Vercel provider factory is built per request with the key the
 * app already resolved — never read from the process env by the SDK.
 */
import type { LanguageModel } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createMistral } from "@ai-sdk/mistral";
import { createAzure } from "@ai-sdk/azure";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import type { Api, Model, StreamOptions } from "./types.ts";

export interface ResolvedApiKey {
  apiKey: string;
  source: string;
}

/** Build the Vercel provider settings common to every factory from a model's
 * metadata (baseUrl / headers) plus the resolved key. */
function settingsFor(
  model: Model<Api>,
  key: ResolvedApiKey,
): {
  apiKey: string;
  baseURL?: string;
  headers?: Record<string, string>;
  name: string;
} {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(model.headers ?? {})) {
    if (v !== null) headers[k] = v;
  }
  return {
    apiKey: key.apiKey,
    baseURL: model.baseUrl,
    headers: Object.keys(headers).length > 0 ? headers : undefined,
    name: `${model.provider}:${model.id}`,
  };
}

/**
 * Map a Lumisca model (with its api) to a Vercel language model. The api
 * string selects which provider factory to use; unknown/OpenAI-compatible
 * apis fall back to {@link createOpenAICompatible}.
 */
export function languageModelFor(
  model: Model<Api>,
  key: ResolvedApiKey,
): LanguageModel {
  const settings = settingsFor(model, key);
  switch (model.api) {
    case "openai-completions":
      // First-party OpenAI uses the official chat model; OpenAI-compatible
      // endpoints (DeepInfra, ClinePass, opencode-go, custom) use the
      // compatible factory. Both expose a chat model for this api.
      return isFirstPartyOpenAI(model)
        ? createOpenAI(settings).chat(model.id)
        : compatibleSettings(model, settings).chatModel(model.id);
    case "openai-responses":
      return isFirstPartyOpenAI(model)
        ? createOpenAI(settings).responses(model.id)
        : compatibleSettings(model, settings).chatModel(model.id);
    case "anthropic-messages":
      return createAnthropic(settings)(model.id);
    case "google-generative-ai":
      return createGoogleGenerativeAI(settings)(model.id);
    case "google-vertex":
      return createGoogleGenerativeAI(settings)(model.id);
    case "mistral-conversations":
      return createMistral(settings)(model.id);
    case "azure-openai-responses":
      return createAzure(settings)(model.id);
    case "bedrock-converse-stream":
      return createAmazonBedrock(settings)(model.id);
    default:
      return compatibleSettings(model, settings).chatModel(model.id);
  }
}

/** build a compatible provider (baseURL + name required). */
function compatibleSettings(
  model: Model<Api>,
  settings: { apiKey: string; baseURL?: string; headers?: Record<string, string>; name: string },
) {
  return createOpenAICompatible({
    name: settings.name,
    baseURL: model.baseUrl ?? "https://api.openai.com/v1",
    apiKey: settings.apiKey,
    headers: settings.headers,
  });
}

/** OpenCode Go's managed-inference API requires a stable per-conversation id
 * on every request (the x-opencode-session header, mandatory since
 * 2026-09-05 — see vercel/ai#20271). The AI SDK does not manage
 * conversations, so the transport maps the caller's conversation id onto
 * that header. Same id as models/extra-providers.ts's catalog constant;
 * duplicated here so the transport layer stays independent of the catalog. */
const OPENCODE_GO_PROVIDER_ID = "opencode-go";

/** Request headers that carry the caller's conversation id onto the
 * provider (see {@link OPENCODE_GO_PROVIDER_ID}). Undefined for providers
 * without session affinity; applied by the stream transport per request so
 * the Vercel SDK merges them over the provider factory's own headers.
 * Throws when an OpenCode Go request has no conversation id — the gateway
 * rejects header-less requests outright, so fail here with the cause
 * instead of surfacing a remote 400. */
export function sessionHeadersFor(
  model: Model<Api>,
  options?: StreamOptions,
): Record<string, string> | undefined {
  if (model.provider !== OPENCODE_GO_PROVIDER_ID) return undefined;
  const sessionId = options?.sessionId;
  if (sessionId === undefined || sessionId === "") {
    throw new Error(
      "OpenCode Go requests need a stable conversation id: pass options.sessionId (sent as the x-opencode-session header)",
    );
  }
  return { "x-opencode-session": sessionId };
}

/** True for the first-party OpenAI provider (which supports the responses
 * api natively); everything else is routed through the compatible factory. */
function isFirstPartyOpenAI(model: Model<Api>): boolean {
  return model.provider === "openai" ||
    model.baseUrl === undefined ||
    /api\.openai\.com/i.test(model.baseUrl ?? "");
}
