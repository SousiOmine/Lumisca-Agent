/**
 * The stored web-search setting and the rules that keep it sound.
 *
 * One settings entry (`WEB_SEARCH_KEY`) holds the whole configuration: the
 * default provider's id and, per configured provider, its API key. It is
 * stored as JSON because a key is a secret and the generic settings surface
 * must never hand it out (see settings/guard.ts).
 *
 * The rules below are the reason this module exists rather than parsing the
 * JSON at each call site:
 *
 * - a provider id the build does not have is dropped (an old settings file
 *   that names a removed provider must not break search);
 * - an entry without a key is dropped (it could not search);
 * - a stored default that names a provider this configuration no longer has
 *   is repaired to the first configured one, while an absent default stays
 *   absent (that is how search is switched off). Removing the default
 *   provider itself hands the default to the next one.
 */

import { isRecord } from "../fs.ts";
import { safeJsonParse } from "../shared/misc.ts";
import { WEB_SEARCH_KEY } from "../shared/settings-keys.ts";
import {
  isWebSearchProviderId,
  providerInfo,
  WEB_SEARCH_PROVIDER_IDS,
} from "./providers/registry.ts";
import type { WebSearchProviderId } from "./types.ts";

/** One provider's stored configuration. */
export interface StoredWebSearchProvider {
  apiKey: string;
}

/** The whole stored configuration. */
export interface StoredWebSearchSettings {
  /** The provider the agent searches with, or null when none is set up. */
  defaultId: WebSearchProviderId | null;
  /** Configured providers, in the provider table's order. */
  providers: Map<WebSearchProviderId, StoredWebSearchProvider>;
}

/** Reading and writing the setting. */
export interface WebSearchSettingsStore {
  read(): StoredWebSearchSettings;
  /** Replace the whole configuration (validated by {@link normalize}). */
  write(settings: StoredWebSearchSettings): void;
}

/** Backed by the settings store (the JSONC file). */
export function createWebSearchSettingsStore(
  settings: {
    get(key: string): string | undefined;
    set(key: string, value: string): void;
  },
): WebSearchSettingsStore {
  return {
    read: () => parseWebSearchSettings(settings.get(WEB_SEARCH_KEY)),
    write: (next) => {
      settings.set(WEB_SEARCH_KEY, serializeWebSearchSettings(next));
    },
  };
}

/** Parse the stored JSON into the usable configuration. Unset, malformed or
 * partly unusable values degrade to what can work (see the module comment);
 * an unusable provider is dropped, not repaired. */
export function parseWebSearchSettings(
  raw: string | undefined | null,
): StoredWebSearchSettings {
  const parsed = safeJsonParse<unknown>(raw);
  if (!isRecord(parsed)) return emptyWebSearchSettings();

  const entries = isRecord(parsed["providers"]) ? parsed["providers"] : {};
  const providers = new Map<WebSearchProviderId, StoredWebSearchProvider>();
  for (const id of WEB_SEARCH_PROVIDER_IDS) {
    const entry = entries[id];
    if (!isRecord(entry)) continue;
    const apiKey = typeof entry["apiKey"] === "string"
      ? entry["apiKey"].trim()
      : "";
    if (apiKey.length === 0) continue;
    providers.set(id, { apiKey });
  }

  // A stored id that names a provider this configuration no longer has is
  // repaired to the first configured one. An absent (or null) default is not
  // repaired: that is how search is switched off, and it must stay off.
  const storedDefault = parsed["default"];
  const defaultId = typeof storedDefault !== "string"
    ? null
    : isWebSearchProviderId(storedDefault) && providers.has(storedDefault)
    ? storedDefault
    : firstConfigured(providers);

  return { defaultId, providers };
}

/** The JSON form. Key order follows the provider table, so the file reads the
 * same way whenever it is rewritten. */
export function serializeWebSearchSettings(
  settings: StoredWebSearchSettings,
): string {
  const providers: Record<string, { apiKey: string }> = {};
  for (const id of WEB_SEARCH_PROVIDER_IDS) {
    const entry = settings.providers.get(id);
    if (entry === undefined) continue;
    providers[id] = { apiKey: entry.apiKey };
  }
  return JSON.stringify({
    default: settings.defaultId,
    providers,
  });
}

/** An empty configuration: no provider, so no search tools. */
export function emptyWebSearchSettings(): StoredWebSearchSettings {
  return { defaultId: null, providers: new Map() };
}

/** The provider ids that are configured, in table order. */
export function configuredProviderIds(
  settings: StoredWebSearchSettings,
): WebSearchProviderId[] {
  return WEB_SEARCH_PROVIDER_IDS.filter((id) => settings.providers.has(id));
}

/** The provider ids that can still be added, in table order. */
export function availableProviderIds(
  settings: StoredWebSearchSettings,
): WebSearchProviderId[] {
  return WEB_SEARCH_PROVIDER_IDS.filter((id) => !settings.providers.has(id));
}

/** Add a provider. A configuration without a default gets this one as its
 * default: the first provider added is the one search uses. */
export function addWebSearchProvider(
  settings: StoredWebSearchSettings,
  id: WebSearchProviderId,
  apiKey: string,
): StoredWebSearchSettings {
  const providers = new Map(settings.providers);
  providers.set(id, { apiKey: normalizeApiKey(apiKey) });
  return {
    defaultId: settings.defaultId ?? id,
    providers,
  };
}

/** Change one provider's key. An unknown provider is left out (the caller
 * has already rejected it). */
export function updateWebSearchProvider(
  settings: StoredWebSearchSettings,
  id: WebSearchProviderId,
  apiKey: string,
): StoredWebSearchSettings {
  if (!settings.providers.has(id)) return settings;
  const providers = new Map(settings.providers);
  providers.set(id, { apiKey: normalizeApiKey(apiKey) });
  return { defaultId: settings.defaultId, providers };
}

/** Remove a provider. Removing the default hands the default to the first
 * remaining provider, or leaves none — a default that is not configured is
 * never stored, so search keeps working wherever there is something to
 * search with. */
export function removeWebSearchProvider(
  settings: StoredWebSearchSettings,
  id: WebSearchProviderId,
): StoredWebSearchSettings {
  const providers = new Map(settings.providers);
  providers.delete(id);
  return {
    defaultId: settings.defaultId === id
      ? firstConfigured(providers)
      : settings.defaultId,
    providers,
  };
}

/** Choose the default. The caller validates that the provider is configured;
 * null leaves no provider, which turns search off. */
export function setDefaultWebSearchProvider(
  settings: StoredWebSearchSettings,
  id: WebSearchProviderId | null,
): StoredWebSearchSettings {
  return { defaultId: id, providers: settings.providers };
}

/** Keys are pasted and may carry whitespace; nothing else is touched (a key
 * is opaque). */
export function normalizeApiKey(apiKey: string): string {
  return apiKey.trim();
}

/** The first configured provider, in table order. */
function firstConfigured(
  providers: Map<WebSearchProviderId, StoredWebSearchProvider>,
): WebSearchProviderId | null {
  return configuredProviderIds({ defaultId: null, providers })[0] ?? null;
}

/** The display name of a provider (for messages the user reads). */
export function webSearchProviderName(id: WebSearchProviderId): string {
  return providerInfo(id).name;
}
