import type { Provider } from "../ai/types.ts";
import {
  clinepassProvider,
  deepinfraProvider,
  opencodeGoProvider,
} from "./dev-catalog.ts";

/**
 * Lumisca-shipped providers that are not part of the first-party @ai-sdk
 * packages: DeepInfra (open-weight marketplace), ClinePass (Cline
 * subscription) and OpenCode Go. Their metadata now comes from models.dev
 * (see dev-catalog.ts) — this module only exposes the ids/URLs and the
 * provider builders, so the rest of the app keeps a stable import surface.
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

/** Every Lumisca-shipped provider outside the SDK catalog. Registered by
 * ModelManager after the built-ins. The DeepInfra / ClinePass / OpenCode Go
 * providers already come from models.dev (dev-catalog.ts), so there is no
 * separate Lumisca-shipped set — this is kept for the import surface. */
export function extraProviders(): Provider[] {
  return [];
}
