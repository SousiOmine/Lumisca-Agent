import { envApiKeyAuth } from "@earendil-works/pi-ai";
import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import { buildProvider } from "./custom.ts";

/**
 * Lumisca-shipped LLM providers that are not part of pi-ai's built-in
 * catalog: DeepInfra (an open-weight model marketplace) and ClinePass
 * (Cline's monthly-subscription plan, served through Cline's
 * OpenAI-compatible API). Both speak OpenAI-compatible chat completions,
 * so they are registered like the SDK's own API-key providers (env var
 * auth, API-key entry in the settings UI, and no "configured" status
 * until a key is stored).
 */

/** Provider id of DeepInfra. */
export const DEEPINFRA_PROVIDER_ID = "deepinfra";

/** Provider id of ClinePass. */
export const CLINEPASS_PROVIDER_ID = "clinepass";

/** DeepInfra's OpenAI-compatible endpoint (chat completions + models). */
export const DEEPINFRA_BASE_URL = "https://api.deepinfra.com/v1/openai";

/** Cline's OpenAI-compatible endpoint; ClinePass serves its models here.
 * Cline's API expects the full "cline-pass/<model>" slug in the model
 * field, so the model ids below carry the cline-pass/ prefix. */
export const CLINEPASS_BASE_URL = "https://api.cline.bot/api/v1";

// ─── DeepInfra ─────────────────────────────────────────────────────────────
//
// DeepInfra is an OpenAI-compatible marketplace for open-weight models.
// Catalog snapshot taken from models.dev (2026-09-03); DeepInfra rotates
// models frequently, so treat this as the curated default set — the
// provider can still be overridden via models.json (see custom.ts).

interface DeepInfraModelDef {
  id: string;
  name: string;
  input: ("text" | "image")[];
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
}

const DEEPINFRA_MODELS: readonly DeepInfraModelDef[] = [
  {
    id: "tencent/Hy3",
    name: "Hy3",
    input: ["text"],
    contextWindow: 262144,
    maxTokens: 128000,
    reasoning: true,
    cost: { input: 0.14, output: 0.58, cacheRead: 0.035, cacheWrite: 0 },
  },
  {
    id: "XiaomiMiMo/MiMo-V2.5",
    name: "MiMo-V2.5",
    input: ["text", "image"],
    contextWindow: 262144,
    maxTokens: 16384,
    reasoning: true,
    cost: { input: 0.4, output: 2, cacheRead: 0.08, cacheWrite: 0 },
  },
  {
    id: "XiaomiMiMo/MiMo-V2.5-Pro",
    name: "MiMo-V2.5-Pro",
    input: ["text"],
    contextWindow: 1048576,
    maxTokens: 16384,
    reasoning: true,
    cost: { input: 1, output: 3, cacheRead: 0.2, cacheWrite: 0 },
  },
  {
    id: "MiniMaxAI/MiniMax-M2.7",
    name: "MiniMax-M2.7",
    input: ["text"],
    contextWindow: 196608,
    maxTokens: 131072,
    reasoning: true,
    cost: { input: 0.25, output: 1, cacheRead: 0.05, cacheWrite: 0 },
  },
  {
    id: "MiniMaxAI/MiniMax-M3",
    name: "MiniMax-M3",
    input: ["text", "image"],
    contextWindow: 524288,
    maxTokens: 512000,
    reasoning: true,
    cost: { input: 0.28, output: 1.1, cacheRead: 0.056, cacheWrite: 0 },
  },
  {
    id: "MiniMaxAI/MiniMax-M2.5",
    name: "MiniMax M2.5",
    input: ["text"],
    contextWindow: 196608,
    maxTokens: 131072,
    reasoning: true,
    cost: { input: 0.15, output: 1.15, cacheRead: 0.03, cacheWrite: 0 },
  },
  {
    id: "nvidia/Llama-3.3-Nemotron-Super-49B-v1.5",
    name: "Llama 3.3 Nemotron Super 49B v1.5",
    input: ["text"],
    contextWindow: 131072,
    maxTokens: 131072,
    reasoning: true,
    cost: { input: 0.4, output: 0.4, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "nvidia/Nemotron-3-Nano-30B-A3B",
    name: "Nemotron 3 Nano 30B A3B",
    input: ["text"],
    contextWindow: 262144,
    maxTokens: 262144,
    reasoning: true,
    cost: { input: 0.05, output: 0.2, cacheRead: 0.025, cacheWrite: 0 },
  },
  {
    id: "nvidia/Nemotron-3-Nano-Omni-30B-A3B-Reasoning",
    name: "Nemotron 3 Nano Omni 30B A3B Reasoning",
    input: ["text", "image"],
    contextWindow: 262144,
    maxTokens: 65536,
    reasoning: true,
    cost: { input: 0.2, output: 0.8, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "google/gemma-4-26B-A4B-it",
    name: "Gemma 4 26B A4B IT",
    input: ["text", "image"],
    contextWindow: 262144,
    maxTokens: 32768,
    reasoning: true,
    cost: { input: 0.07, output: 0.34, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "google/gemma-4-E4B-it",
    name: "Gemma 4 E4B IT",
    input: ["text", "image"],
    contextWindow: 131072,
    maxTokens: 8192,
    reasoning: true,
    cost: { input: 0.02, output: 0.1, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "google/gemma-4-31B-it",
    name: "Gemma 4 31B IT",
    input: ["text", "image"],
    contextWindow: 262144,
    maxTokens: 32768,
    reasoning: true,
    cost: { input: 0.13, output: 0.38, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "ByteDance/Seed-2.0-code",
    name: "Seed 2.0 Code",
    input: ["text", "image"],
    contextWindow: 256000,
    maxTokens: 131072,
    reasoning: true,
    cost: { input: 0.5, output: 3, cacheRead: 0.1, cacheWrite: 0 },
  },
  {
    id: "ByteDance/Seed-2.0-pro",
    name: "Seed 2.0 Pro",
    input: ["text", "image"],
    contextWindow: 256000,
    maxTokens: 128000,
    reasoning: true,
    cost: { input: 0.5, output: 3, cacheRead: 0.1, cacheWrite: 0 },
  },
  {
    id: "ByteDance/Seed-2.0-mini",
    name: "Seed 2.0 Mini",
    input: ["text", "image"],
    contextWindow: 256000,
    maxTokens: 32000,
    reasoning: true,
    cost: { input: 0.1, output: 0.4, cacheRead: 0.02, cacheWrite: 0 },
  },
  {
    id: "moonshotai/Kimi-K2.5",
    name: "Kimi K2.5",
    input: ["text", "image"],
    contextWindow: 262144,
    maxTokens: 32768,
    reasoning: true,
    cost: { input: 0.45, output: 2.25, cacheRead: 0.07, cacheWrite: 0 },
  },
  {
    id: "moonshotai/Kimi-K2.7-Code",
    name: "Kimi K2.7 Code",
    input: ["text", "image"],
    contextWindow: 262144,
    maxTokens: 262144,
    reasoning: true,
    cost: { input: 0.68, output: 3.4, cacheRead: 0.136, cacheWrite: 0 },
  },
  {
    id: "moonshotai/Kimi-K3",
    name: "Kimi K3",
    input: ["text", "image"],
    contextWindow: 1048576,
    maxTokens: 131072,
    reasoning: true,
    cost: { input: 2.85, output: 14.25, cacheRead: 0.285, cacheWrite: 0 },
  },
  {
    id: "moonshotai/Kimi-K2.6",
    name: "Kimi K2.6",
    input: ["text", "image"],
    contextWindow: 262144,
    maxTokens: 16384,
    reasoning: true,
    cost: { input: 0.75, output: 3.5, cacheRead: 0.15, cacheWrite: 0 },
  },
  {
    id: "openai/gpt-oss-120b",
    name: "GPT OSS 120B",
    input: ["text"],
    contextWindow: 131072,
    maxTokens: 16384,
    reasoning: true,
    cost: { input: 0.037, output: 0.17, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "openai/gpt-oss-20b",
    name: "GPT OSS 20B",
    input: ["text"],
    contextWindow: 131072,
    maxTokens: 16384,
    reasoning: true,
    cost: { input: 0.03, output: 0.14, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "deepseek-ai/DeepSeek-V4-Pro",
    name: "DeepSeek V4 Pro",
    input: ["text"],
    contextWindow: 1048576,
    maxTokens: 16384,
    reasoning: true,
    cost: { input: 1.3, output: 2.6, cacheRead: 0.1, cacheWrite: 0 },
  },
  {
    id: "deepseek-ai/DeepSeek-V4-Flash-0731",
    name: "DeepSeek V4 Flash 0731",
    input: ["text"],
    contextWindow: 1048576,
    maxTokens: 384000,
    reasoning: true,
    cost: { input: 0.08, output: 0.18, cacheRead: 0.016, cacheWrite: 0 },
  },
  {
    id: "deepseek-ai/DeepSeek-V3.2",
    name: "DeepSeek-V3.2",
    input: ["text"],
    contextWindow: 163840,
    maxTokens: 64000,
    reasoning: true,
    cost: { input: 0.26, output: 0.38, cacheRead: 0.13, cacheWrite: 0 },
  },
  {
    id: "deepseek-ai/DeepSeek-R1-0528",
    name: "DeepSeek-R1-0528",
    input: ["text"],
    contextWindow: 163840,
    maxTokens: 64000,
    reasoning: true,
    cost: { input: 0.5, output: 2.15, cacheRead: 0.35, cacheWrite: 0 },
  },
  {
    id: "deepseek-ai/DeepSeek-V3.1",
    name: "DeepSeek-V3.1",
    input: ["text"],
    contextWindow: 163840,
    maxTokens: 8192,
    reasoning: true,
    cost: { input: 0.25, output: 0.95, cacheRead: 0.13, cacheWrite: 0 },
  },
  {
    id: "deepseek-ai/DeepSeek-V3-0324",
    name: "DeepSeek V3 0324",
    input: ["text"],
    contextWindow: 163840,
    maxTokens: 163840,
    reasoning: false,
    cost: { input: 0.24, output: 0.9, cacheRead: 0.135, cacheWrite: 0 },
  },
  {
    id: "deepseek-ai/DeepSeek-V4-Pro-0813",
    name: "DeepSeek V4 Pro 0813",
    input: ["text"],
    contextWindow: 1048576,
    maxTokens: 384000,
    reasoning: true,
    cost: { input: 1.3, output: 2.6, cacheRead: 0.1, cacheWrite: 0 },
  },
  {
    id: "deepseek-ai/DeepSeek-V3",
    name: "DeepSeek-V3",
    input: ["text"],
    contextWindow: 163840,
    maxTokens: 8192,
    reasoning: false,
    cost: { input: 0.32, output: 0.89, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "deepseek-ai/DeepSeek-V4-Flash",
    name: "DeepSeek V4 Flash",
    input: ["text"],
    contextWindow: 1048576,
    maxTokens: 16384,
    reasoning: true,
    cost: { input: 0.09, output: 0.18, cacheRead: 0.018, cacheWrite: 0 },
  },
  {
    id: "stepfun-ai/Step-3.7-Flash",
    name: "Step 3.7 Flash",
    input: ["text", "image"],
    contextWindow: 262144,
    maxTokens: 256000,
    reasoning: true,
    cost: { input: 0.2, output: 1.15, cacheRead: 0.04, cacheWrite: 0 },
  },
  {
    id: "Qwen/Qwen3-235B-A22B-Instruct-2507",
    name: "Qwen3 235B-A22B Instruct 2507",
    input: ["text"],
    contextWindow: 262144,
    maxTokens: 16384,
    reasoning: false,
    cost: { input: 0.09, output: 0.55, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "Qwen/Qwen3-VL-235B-A22B-Instruct",
    name: "Qwen3 VL 235B A22B Instruct",
    input: ["text", "image"],
    contextWindow: 262144,
    maxTokens: 32768,
    reasoning: false,
    cost: { input: 0.2, output: 0.88, cacheRead: 0.11, cacheWrite: 0 },
  },
  {
    id: "Qwen/Qwen3.6-27B",
    name: "Qwen3.6 27B",
    input: ["text", "image"],
    contextWindow: 262144,
    maxTokens: 65536,
    reasoning: true,
    cost: { input: 0.32, output: 3.2, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "Qwen/Qwen3.5-9B",
    name: "Qwen3.5 9B",
    input: ["text", "image"],
    contextWindow: 262144,
    maxTokens: 65536,
    reasoning: true,
    cost: { input: 0.1, output: 0.15, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "Qwen/Qwen3-Coder-480B-A35B-Instruct-Turbo",
    name: "Qwen3 Coder 480B A35B Instruct Turbo",
    input: ["text"],
    contextWindow: 262144,
    maxTokens: 66536,
    reasoning: false,
    cost: { input: 0.3, output: 1, cacheRead: 0.1, cacheWrite: 0 },
  },
  {
    id: "Qwen/Qwen3.5-122B-A10B",
    name: "Qwen3.5 122B-A10B",
    input: ["text", "image"],
    contextWindow: 262144,
    maxTokens: 65536,
    reasoning: true,
    cost: { input: 0.29, output: 2.4, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "Qwen/Qwen3-32B",
    name: "Qwen3 32B",
    input: ["text"],
    contextWindow: 40960,
    maxTokens: 16384,
    reasoning: true,
    cost: { input: 0.08, output: 0.28, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "Qwen/Qwen3.8-Max",
    name: "Qwen3.8 Max",
    input: ["text", "image"],
    contextWindow: 256000,
    maxTokens: 131072,
    reasoning: false,
    cost: { input: 1.65, output: 4.951, cacheRead: 0.206, cacheWrite: 0 },
  },
  {
    id: "Qwen/Qwen3.7-Max",
    name: "Qwen3.7 Max",
    input: ["text"],
    contextWindow: 256000,
    maxTokens: 65536,
    reasoning: false,
    cost: { input: 2.5, output: 7.5, cacheRead: 0.5, cacheWrite: 0 },
  },
  {
    id: "Qwen/Qwen3.5-27B",
    name: "Qwen3.5 27B",
    input: ["text", "image"],
    contextWindow: 262144,
    maxTokens: 65536,
    reasoning: true,
    cost: { input: 0.26, output: 2.6, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "Qwen/Qwen3.5-35B-A3B",
    name: "Qwen 3.5 35B A3B",
    input: ["text", "image"],
    contextWindow: 262144,
    maxTokens: 81920,
    reasoning: true,
    cost: { input: 0.14, output: 1, cacheRead: 0.05, cacheWrite: 0 },
  },
  {
    id: "Qwen/Qwen3-Max",
    name: "Qwen3 Max",
    input: ["text"],
    contextWindow: 256000,
    maxTokens: 65536,
    reasoning: false,
    cost: { input: 1.2, output: 6, cacheRead: 0.24, cacheWrite: 0 },
  },
  {
    id: "Qwen/Qwen3-30B-A3B",
    name: "Qwen3 30B A3B",
    input: ["text"],
    contextWindow: 40960,
    maxTokens: 16384,
    reasoning: true,
    cost: { input: 0.12, output: 0.5, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "Qwen/Qwen3.5-397B-A17B",
    name: "Qwen 3.5 397B A17B",
    input: ["text", "image"],
    contextWindow: 262144,
    maxTokens: 81920,
    reasoning: true,
    cost: { input: 0.45, output: 3, cacheRead: 0.22, cacheWrite: 0 },
  },
  {
    id: "Qwen/Qwen3.6-35B-A3B",
    name: "Qwen3.6 35B A3B",
    input: ["text", "image"],
    contextWindow: 262144,
    maxTokens: 81920,
    reasoning: true,
    cost: { input: 0.1, output: 0.95, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "Qwen/Qwen3.8-2.4T-A95B",
    name: "Qwen3.8 2.4T A95B",
    input: ["text"],
    contextWindow: 262144,
    maxTokens: 131072,
    reasoning: true,
    cost: { input: 2, output: 6, cacheRead: 0.2, cacheWrite: 0 },
  },
  {
    id: "Qwen/Qwen3.8-27B",
    name: "Qwen3.8 27B",
    input: ["text", "image"],
    contextWindow: 262144,
    maxTokens: 32768,
    reasoning: true,
    cost: { input: 0.4, output: 3, cacheRead: 0.04, cacheWrite: 0 },
  },
  {
    id: "Qwen/Qwen3-Next-80B-A3B-Instruct",
    name: "Qwen3-Next 80B-A3B Instruct",
    input: ["text"],
    contextWindow: 262144,
    maxTokens: 32768,
    reasoning: false,
    cost: { input: 0.09, output: 1.1, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "zai-org/GLM-5.3-Flash",
    name: "GLM-5.3-Flash",
    input: ["text", "image"],
    contextWindow: 1048576,
    maxTokens: 131072,
    reasoning: true,
    cost: { input: 0.15, output: 0.5, cacheRead: 0.03, cacheWrite: 0 },
  },
  {
    id: "zai-org/GLM-5.1",
    name: "GLM-5.1",
    input: ["text"],
    contextWindow: 202752,
    maxTokens: 16384,
    reasoning: true,
    cost: { input: 1.05, output: 3.5, cacheRead: 0.205, cacheWrite: 0 },
  },
  {
    id: "zai-org/GLM-5.3",
    name: "GLM-5.3",
    input: ["text"],
    contextWindow: 1048576,
    maxTokens: 131072,
    reasoning: true,
    cost: { input: 1.2, output: 4, cacheRead: 0.12, cacheWrite: 0 },
  },
  {
    id: "zai-org/GLM-4.6",
    name: "GLM-4.6",
    input: ["text"],
    contextWindow: 202752,
    maxTokens: 131072,
    reasoning: true,
    cost: { input: 0.5, output: 2, cacheRead: 0.1, cacheWrite: 0 },
  },
  {
    id: "zai-org/GLM-5",
    name: "GLM-5",
    input: ["text"],
    contextWindow: 202752,
    maxTokens: 16384,
    reasoning: true,
    cost: { input: 0.6, output: 2.08, cacheRead: 0.12, cacheWrite: 0 },
  },
  {
    id: "zai-org/GLM-4.7",
    name: "GLM-4.7",
    input: ["text"],
    contextWindow: 202752,
    maxTokens: 16384,
    reasoning: true,
    cost: { input: 0.4, output: 1.75, cacheRead: 0.08, cacheWrite: 0 },
  },
  {
    id: "zai-org/GLM-5.2",
    name: "GLM-5.2",
    input: ["text"],
    contextWindow: 1048576,
    maxTokens: 32768,
    reasoning: true,
    cost: { input: 0.75, output: 2.4, cacheRead: 0.14, cacheWrite: 0 },
  },
  {
    id: "zai-org/GLM-4.7-Flash",
    name: "GLM-4.7-Flash",
    input: ["text"],
    contextWindow: 202752,
    maxTokens: 16384,
    reasoning: true,
    cost: { input: 0.06, output: 0.4, cacheRead: 0.01, cacheWrite: 0 },
  },
  {
    id: "thinkingmachines/Inkling",
    name: "Inkling",
    input: ["text", "image"],
    contextWindow: 524288,
    maxTokens: 1048576,
    reasoning: true,
    cost: { input: 0.95, output: 4.05, cacheRead: 0.16, cacheWrite: 0 },
  },
  {
    id: "thinkingmachines/Inkling-Small",
    name: "Inkling Small",
    input: ["text", "image"],
    contextWindow: 524288,
    maxTokens: 1048576,
    reasoning: true,
    cost: { input: 0.45, output: 1.2, cacheRead: 0.1, cacheWrite: 0 },
  },
  {
    id: "meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8",
    name: "Llama 4 Maverick 17B FP8",
    input: ["text", "image"],
    contextWindow: 1048576,
    maxTokens: 16384,
    reasoning: false,
    cost: { input: 0.2, output: 0.8, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    name: "Llama 3.3 70B Turbo",
    input: ["text"],
    contextWindow: 131072,
    maxTokens: 16384,
    reasoning: false,
    cost: { input: 0.1, output: 0.32, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "meta-llama/Llama-4-Scout-17B-16E-Instruct",
    name: "Llama 4 Scout 17B",
    input: ["text", "image"],
    contextWindow: 327680,
    maxTokens: 16384,
    reasoning: false,
    cost: { input: 0.1, output: 0.3, cacheRead: 0, cacheWrite: 0 },
  },
];

function deepInfraModel(def: DeepInfraModelDef): Model<Api> {
  return {
    id: def.id,
    name: def.name,
    api: "openai-completions",
    provider: DEEPINFRA_PROVIDER_ID,
    baseUrl: DEEPINFRA_BASE_URL,
    reasoning: def.reasoning,
    input: def.input,
    cost: def.cost,
    contextWindow: def.contextWindow,
    maxTokens: def.maxTokens,
    // DeepInfra documents its chat completions with max_tokens; pi-ai's
    // default (max_completion_tokens) is not guaranteed on the
    // marketplace, so pin the documented field.
    compat: { maxTokensField: "max_tokens" },
  };
}

/** DeepInfra: open-weight model marketplace, OpenAI-compatible API. */
export function deepinfraProvider(): Provider {
  return buildProvider({
    id: DEEPINFRA_PROVIDER_ID,
    name: "DeepInfra",
    baseUrl: DEEPINFRA_BASE_URL,
    auth: envApiKeyAuth("DeepInfra API key", ["DEEPINFRA_API_KEY"]),
    models: DEEPINFRA_MODELS.map(deepInfraModel),
  });
}

// ─── ClinePass ─────────────────────────────────────────────────────────────
//
// ClinePass (https://docs.cline.bot/getting-started/clinepass) is Cline's
// $9.99/month subscription: curated coding models served through the Cline
// API. Limits are taken from models.dev (2026-09-03); the thinking maps
// mirror the tested pi-clinepass-provider extension — ClinePass only
// accepts classic chat roles (supportsDeveloperRole: false) and each model
// has its own reasoning_effort enum (see thinkingLevelMap).

interface ClinePassModelDef {
  id: string;
  name: string;
  input: readonly ("text" | "image")[];
  contextWindow: number;
  maxTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  /** Maps pi thinking levels to ClinePass reasoning_effort values ("none"
   * included); null = unsupported for that model. */
  thinkingLevelMap: Record<string, string | null>;
}

const CLINEPASS_MODELS: readonly ClinePassModelDef[] = [
  {
    id: "cline-pass/deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    input: ["text"],
    contextWindow: 1_000_000,
    maxTokens: 384_000,
    cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
    // reasoning_effort: only "none" and "high" are accepted.
    thinkingLevelMap: {
      off: "none",
      minimal: null,
      low: null,
      medium: null,
      high: "high",
      xhigh: "high",
    },
  },
  {
    id: "cline-pass/deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    input: ["text"],
    contextWindow: 1_000_000,
    maxTokens: 384_000,
    cost: { input: 1.74, output: 3.48, cacheRead: 0.0145, cacheWrite: 0 },
    thinkingLevelMap: {
      off: "none",
      minimal: null,
      low: null,
      medium: null,
      high: "high",
      xhigh: "high",
    },
  },
  {
    id: "cline-pass/glm-5.2",
    name: "GLM-5.2",
    input: ["text"],
    contextWindow: 1_000_000,
    maxTokens: 131_072,
    cost: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
    thinkingLevelMap: {
      off: "none",
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
    },
  },
  {
    id: "cline-pass/glm-5.3",
    name: "GLM-5.3",
    input: ["text"],
    contextWindow: 1_000_000,
    maxTokens: 131_072,
    cost: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
    // Always reasons (enum: low/high/max); thinking cannot be disabled.
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: "low",
      medium: null,
      high: "high",
      xhigh: "max",
    },
  },
  {
    id: "cline-pass/kimi-k2.6",
    name: "Kimi K2.6",
    input: ["text"],
    contextWindow: 262_144,
    maxTokens: 262_144,
    cost: { input: 0.95, output: 4.0, cacheRead: 0.16, cacheWrite: 0 },
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: null,
    },
  },
  {
    id: "cline-pass/kimi-k2.7-code",
    name: "Kimi K2.7 Code",
    input: ["text"],
    contextWindow: 262_144,
    maxTokens: 262_144,
    cost: { input: 0.95, output: 4.0, cacheRead: 0.19, cacheWrite: 0 },
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: null,
    },
  },
  {
    id: "cline-pass/kimi-k3",
    name: "Kimi K3",
    input: ["text"],
    contextWindow: 1_048_576,
    maxTokens: 131_072,
    cost: { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 0 },
    // Always reasons; only reasoning_effort="max" is accepted.
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: null,
      medium: null,
      high: "max",
      xhigh: null,
    },
  },
  {
    id: "cline-pass/mimo-v2.5",
    name: "MiMo-V2.5",
    input: ["text"],
    contextWindow: 1_048_576,
    maxTokens: 131_072,
    cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
    thinkingLevelMap: {
      off: "none",
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: null,
    },
  },
  {
    id: "cline-pass/mimo-v2.5-pro",
    name: "MiMo-V2.5-Pro",
    input: ["text"],
    contextWindow: 1_048_576,
    maxTokens: 131_072,
    cost: { input: 1.74, output: 3.48, cacheRead: 0.0145, cacheWrite: 0 },
    thinkingLevelMap: {
      off: "none",
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: null,
    },
  },
  {
    id: "cline-pass/minimax-m3",
    name: "MiniMax-M3",
    input: ["text"],
    contextWindow: 1_048_576,
    maxTokens: 512_000,
    cost: { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0 },
    thinkingLevelMap: {
      off: "none",
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: null,
    },
  },
  {
    id: "cline-pass/qwen3.7-max",
    name: "Qwen3.7 Max",
    input: ["text"],
    contextWindow: 1_000_000,
    maxTokens: 65_536,
    cost: { input: 2.5, output: 7.5, cacheRead: 0.5, cacheWrite: 3.125 },
    thinkingLevelMap: {
      off: "none",
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: null,
    },
  },
  {
    id: "cline-pass/qwen3.7-plus",
    name: "Qwen3.7 Plus",
    input: ["text"],
    contextWindow: 1_000_000,
    maxTokens: 64_000,
    cost: { input: 0.4, output: 1.6, cacheRead: 0.04, cacheWrite: 0.5 },
    thinkingLevelMap: {
      off: "none",
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: null,
    },
  },
  {
    id: "cline-pass/qwen3.8-max",
    name: "Qwen3.8 Max",
    input: ["text"],
    contextWindow: 1_000_000,
    maxTokens: 131_072,
    cost: { input: 2.0, output: 6.0, cacheRead: 0.25, cacheWrite: 2.5 },
    // reasoning_effort enum: low/medium/xhigh; thinking cannot be turned
    // off (effort="none" is out of enum and silently ignored).
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: "low",
      medium: "medium",
      high: null,
      xhigh: "xhigh",
    },
  },
];

function clinepassModel(def: ClinePassModelDef): Model<Api> {
  return {
    id: def.id,
    name: def.name,
    api: "openai-completions",
    provider: CLINEPASS_PROVIDER_ID,
    baseUrl: CLINEPASS_BASE_URL,
    reasoning: true,
    input: [...def.input],
    cost: def.cost,
    contextWindow: def.contextWindow,
    maxTokens: def.maxTokens,
    thinkingLevelMap: def.thinkingLevelMap,
    // ClinePass only accepts classic chat roles (system/assistant/user/
    // tool); pi-ai would otherwise use the developer role for reasoning
    // models and ClinePass rejects the request.
    compat: { supportsDeveloperRole: false },
  };
}

/** ClinePass: Cline's monthly subscription plan, OpenAI-compatible API. */
export function clinepassProvider(): Provider {
  return buildProvider({
    id: CLINEPASS_PROVIDER_ID,
    name: "ClinePass",
    baseUrl: CLINEPASS_BASE_URL,
    auth: envApiKeyAuth("ClinePass API key", ["CLINE_API_KEY"]),
    models: CLINEPASS_MODELS.map(clinepassModel),
  });
}

/** Every Lumisca-shipped provider outside the SDK catalog. Registered by
 * ModelManager after the SDK built-ins (setProvider upserts by id, so a
 * models.json config may still deliberately override these). */
export function extraProviders(): Provider[] {
  return [deepinfraProvider(), clinepassProvider()];
}
