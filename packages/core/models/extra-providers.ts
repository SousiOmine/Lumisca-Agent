import {
  clinepassProvider,
  deepinfraProvider,
  opencodeGoProvider,
} from "./dev-catalog.ts";

/**
 * Lumisca-shipped providers that are not part of the first-party @ai-sdk
 * packages: DeepInfra (open-weight marketplace), ClinePass (Cline
 * subscription) and OpenCode Go. Their metadata comes from models.dev
 * (see dev-catalog.ts) — this module only exposes their ids, endpoint URLs
 * and provider builders.
 */

/** Provider id of DeepInfra. */
export const DEEPINFRA_PROVIDER_ID = "deepinfra";

/** Provider id of ClinePass. */
export const CLINEPASS_PROVIDER_ID = "cline-pass";

/** Provider id of OpenCode Go. */
export const OPENCODE_GO_PROVIDER_ID = "opencode-go";

/** DeepInfra's OpenAI-compatible endpoint (chat completions + models). */
export const DEEPINFRA_BASE_URL = "https://api.deepinfra.com/v1/openai";

/** Cline's OpenAI-compatible endpoint; ClinePass serves its models here. */
export const CLINEPASS_BASE_URL = "https://api.cline.bot/api/v1";

export { clinepassProvider, deepinfraProvider, opencodeGoProvider };
