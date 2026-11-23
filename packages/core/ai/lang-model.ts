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

import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createAzure } from "@ai-sdk/azure";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createMistral } from "@ai-sdk/mistral";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import type { Api } from "../domain/model.ts";
import type { Model } from "./catalog.ts";
import type { StreamOptions } from "./transport.ts";

export interface ResolvedApiKey {
  apiKey: string;
  source: string;
  /** Headers the provider derived from the credential itself (the ChatGPT
   * account id). They win over the model's static headers: a catalog entry
   * cannot know which account is signed in. */
  headers?: Record<string, string>;
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
  for (const [k, v] of Object.entries(key.headers ?? {})) {
    headers[k] = v;
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
      // The api declares the OpenAI Responses API, so drive it with the
      // @ai-sdk/openai responses model against the model's own base URL.
      // Third-party gateways that only serve some models over /v1/responses
      // (OpenCode Go / Zen Responses-only models, custom user providers
      // that picked this api) must not be downgraded to chat completions —
      // their gateway rejects chat requests for those models.
      return createOpenAI(settings).responses(model.id);
    case "anthropic-messages":
      // @ai-sdk/anthropic appends `/messages` to the base URL. Gateways
      // that expose an Anthropic-style endpoint per model publish the full
      // model path in the model id (OpenCode Zen: base URL
      // https://opencode.ai/zen/v1 with ids like `models/minimax-m3`), so
      // the id doubles as the API path.
      return createAnthropic(settings)(model.id);
    case "google-generative-ai":
    case "google-vertex":
      // @ai-sdk/google appends `/models/{id}:generateContent` to the base
      // URL. Gateways that expose a Gemini-style endpoint per model publish
      // the full model path in the model id (OpenCode Zen: base URL
      // https://opencode.ai/zen/v1 with ids like `models/gemini-3.5-flash`),
      // so the id doubles as the API path.
      return createGoogleGenerativeAI(settings)(model.id);
    case "mistral-conversations":
      // @ai-sdk/mistral appends `/chat/completions` to the base URL with
      // the model id in the request body, so it stays on the provider base
      // URL and the plain model id.
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
  settings: {
    apiKey: string;
    baseURL?: string;
    headers?: Record<string, string>;
    name: string;
  },
) {
  return createOpenAICompatible({
    name: settings.name,
    baseURL: model.baseUrl ?? "https://api.openai.com/v1",
    apiKey: settings.apiKey,
    headers: settings.headers,
    // Tool results keep their image blocks as image parts of the tool
    // message. The SDK leaves this off by default (its docs: "enable this
    // for providers that extend the OpenAI Chat Completions API with
    // structured tool-result content"), which makes a tool result with an
    // image degrade to JSON — the model reads a base64 wall of text instead
    // of the picture. Lumisca turns it on for every compatible endpoint on
    // purpose: the images of a tool result only ever travel to a model that
    // declares image input (see ai/stream.ts toCoreMessages). A gateway
    // that cannot carry them is excluded there, not here: the OpenCode
    // gateway forwards tool messages to its upstream over gRPC, which
    // carries text parts only (see toolResultTakesImages).
    supportsMultiPartToolContent: true,
  });
}

/** Whether the provider conversion of this model keeps an image part inside
 * a tool result (see ai/stream.ts toCoreMessages). It mirrors
 * {@link languageModelFor}, because the answer is the transport's:
 * @ai-sdk/anthropic, the OpenAI Responses models (Azure's included),
 * @ai-sdk/google and Bedrock map a file part of a tool result onto their
 * native image form, and the compatible factory above takes image parts
 * too — while the first-party OpenAI chat model (api.openai.com) and
 * @ai-sdk/mistral serialize a content output as JSON. Those two get their
 * images in a user message of their own instead (see toCoreMessages).
 *
 * The OpenCode gateway (Zen and Go) is a third exception even though it is
 * a compatible endpoint: it forwards tool messages to its upstream over
 * gRPC, which only carries text parts, and rejects a multi-part tool
 * content with HTTP 400 ("tool message content part 1 is not text"). Its
 * models get the images in a user message too. */
export function toolResultTakesImages(model: Model<Api>): boolean {
  // A catalog entry that knows better than the api's default says so
  // directly (see Model.compat.toolResultCarriesImages).
  const declared = model.compat?.toolResultCarriesImages;
  if (declared !== undefined) return declared;
  switch (model.api) {
    case "openai-completions":
      // First-party OpenAI uses the official chat model, which has no
      // multi-part tool content option; every other chat-completions model
      // goes through the compatible factory.
      return !isFirstPartyOpenAI(model) && !isOpenCodeGateway(model);
    case "mistral-conversations":
      return false;
    default:
      // The remaining apis are native image carriers (anthropic, responses,
      // google, bedrock) or the compatible factory (any unknown api string).
      return true;
  }
}

/** Request headers that carry the caller's conversation id onto the
 * provider. A provider that requires one declares its header name on the
 * model (see {@link Model.compat.sessionHeaderName}); undefined for the
 * providers without session affinity. Applied by the stream transport per
 * request, so the Vercel SDK merges them over the provider factory's own
 * headers. Throws when such a request has no conversation id: the gateway
 * rejects header-less requests outright, so fail here with the cause instead
 * of surfacing a remote 400. */
export function sessionHeadersFor(
  model: Model<Api>,
  options?: StreamOptions,
): Record<string, string> | undefined {
  const header = model.compat?.sessionHeaderName;
  if (header === undefined) return undefined;
  const sessionId = options?.sessionId;
  if (sessionId === undefined || sessionId === "") {
    throw new Error(
      `This provider needs a stable conversation id: pass options.sessionId (sent as the ${header} header)`,
    );
  }
  return { [header]: sessionId };
}

/** True when a chat-completions request goes to OpenAI itself: the official
 * @ai-sdk/openai chat model rather than the compatible factory. The endpoint
 * decides, not a provider id — a model that names no base URL is served by
 * OpenAI, and so is one pointed at its host. */
function isFirstPartyOpenAI(model: Model<Api>): boolean {
  return model.baseUrl === undefined || /api\.openai\.com/i.test(model.baseUrl);
}

/** True for the OpenCode gateway (Zen and Go). The host decides, not the
 * provider id: the limitation in {@link toolResultTakesImages} belongs to
 * the endpoint, so a user-provided compatible provider pointed at it hits
 * the same rejection. The catalog's own entries state this on their compat
 * entry; this rule is what reaches a provider the app does not ship. */
function isOpenCodeGateway(model: Model<Api>): boolean {
  return /^https?:\/\/opencode\.ai(?:[:/]|$)/i.test(model.baseUrl ?? "");
}
