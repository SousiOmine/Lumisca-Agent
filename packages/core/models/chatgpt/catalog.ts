/**
 * The ChatGPT subscription provider's model catalog.
 *
 * The list is per account: the backend publishes what the signed-in plan
 * can use, so it cannot come from the shared models.dev catalog. It is
 * fetched once at login and stored in settings; every start reads it back.
 * A failed fetch fails the login — a provider with no models cannot be
 * used, and a guessed list would offer models the plan may not have.
 */
import type { Api, Model, ThinkingLevelMap } from "../../ai/types.ts";
import { isRecord } from "../../fs.ts";
import type { SettingsRepo } from "../../settings/repo.ts";
import { safeJsonParse } from "../../shared/mod.ts";
import { THINKING_LEVEL_ORDER } from "../../shared/providers.ts";
import { CHATGPT_MODELS_KEY } from "../../shared/settings-keys.ts";
import { type FetchLike, requestSignal, truncateBody } from "./http.ts";
import { CHATGPT_API_BASE, CHATGPT_ORIGINATOR } from "./oauth.ts";

/** Provider id of the ChatGPT subscription provider. */
export const CHATGPT_PROVIDER_ID = "openai-codex";

/** The backend's `client_version` query parameter. The endpoint records the
 * client that asked rather than validating the value (community clients
 * send their own), so Lumisca sends a fixed one. */
const CHATGPT_CLIENT_VERSION = "1.0.0";

/** Request the catalog of the signed-in account. */
export async function fetchChatGptModels(
  fetchImpl: FetchLike,
  auth: { token: string; accountId: string },
  signal?: AbortSignal,
): Promise<Model<Api>[]> {
  const url = new URL(`${CHATGPT_API_BASE}/models`);
  url.searchParams.set("client_version", CHATGPT_CLIENT_VERSION);
  const response = await fetchImpl(url, {
    headers: {
      authorization: `Bearer ${auth.token}`,
      "chatgpt-account-id": auth.accountId,
      originator: CHATGPT_ORIGINATOR,
      accept: "application/json",
    },
    signal: requestSignal(signal),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `model catalog request failed: HTTP ${response.status}: ${truncateBody(
        text,
      )}`,
    );
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(
      `model catalog response is not JSON: ${truncateBody(text)}`,
    );
  }
  if (!isRecord(body) || !Array.isArray(body.models)) {
    throw new Error("model catalog response has no models array");
  }
  const models = body.models
    .map(toModel)
    .filter((model): model is Model<Api> => model !== undefined);
  if (models.length === 0) {
    throw new Error("model catalog response listed no usable models");
  }
  return models;
}

/** The stored catalog of the signed-in account, or an empty list when none
 * has been fetched. A malformed entry reads as "no catalog": the picker then
 * has nothing to offer until the next login. */
export function readChatGptModels(
  settings: SettingsRepo,
): readonly Model<Api>[] {
  const parsed = safeJsonParse<unknown>(settings.get(CHATGPT_MODELS_KEY));
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isStoredModel);
}

/** Persist the catalog fetched at login. */
export function saveChatGptModels(
  settings: SettingsRepo,
  models: readonly Model<Api>[],
): void {
  settings.set(CHATGPT_MODELS_KEY, JSON.stringify(models));
}

/** Map one catalog entry. Entries without an id are dropped (the backend
 * occasionally publishes rows for features Lumisca cannot address). */
function toModel(entry: unknown): Model<Api> | undefined {
  if (!isRecord(entry)) return undefined;
  const id =
    typeof entry.slug === "string" && entry.slug.length > 0
      ? entry.slug
      : typeof entry.id === "string" && entry.id.length > 0
        ? entry.id
        : undefined;
  if (id === undefined) return undefined;
  const name =
    typeof entry.display_name === "string" && entry.display_name.length > 0
      ? entry.display_name
      : id;
  const contextWindow =
    numberField(entry.context_window) ?? numberField(entry.max_context_window);
  const efforts = effortsOf(entry);
  return {
    id,
    name,
    api: "openai-responses",
    provider: CHATGPT_PROVIDER_ID,
    baseUrl: CHATGPT_API_BASE,
    reasoning: efforts.length > 0,
    // The Codex models accept images; the catalog does not publish a
    // modality list, so this is the one property Lumisca asserts for them.
    input: ["text", "image"],
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(efforts.length > 0 ? { thinkingLevelMap: thinkingMap(efforts) } : {}),
  };
}

/** The reasoning efforts the entry accepts ("none" included). */
function effortsOf(entry: Record<string, unknown>): string[] {
  const raw = entry.supported_reasoning_levels;
  if (!Array.isArray(raw)) return [];
  const efforts: string[] = [];
  for (const item of raw) {
    if (typeof item === "string") efforts.push(item);
    else if (isRecord(item) && typeof item.effort === "string") {
      efforts.push(item.effort);
    }
  }
  return efforts;
}

/** Map the accepted efforts onto Lumisca's thinking levels. A level the
 * entry does not offer is unsupported (null); "off" always works (no
 * reasoning parameter is sent). */
function thinkingMap(efforts: readonly string[]): ThinkingLevelMap {
  const map: ThinkingLevelMap = {};
  for (const level of THINKING_LEVEL_ORDER) {
    if (level === "off") continue;
    map[level] = efforts.includes(level) ? level : null;
  }
  return map;
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function isStoredModel(value: unknown): value is Model<Api> {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.api === "string" &&
    typeof value.provider === "string"
  );
}
