/**
 * The web-search setting, as the app exposes it.
 *
 * The search library (websearch/, minus this file) is configuration-blind:
 * it takes a key and answers results. This service is where a stored setting
 * becomes the settings screen's view, and where the screen's edits are
 * validated before they reach the file. Kept out of LumiscaCore so the facade
 * stays a facade.
 *
 * Two rules the screen depends on:
 *
 * - a key never leaves the process. The view says whether one is stored, not
 *   what it is;
 * - the configuration is never "set up but unusable". The first provider
 *   added becomes the default, removing the default hands it to the next
 *   provider, and a stored default that no longer exists is repaired on read
 *   (websearch/settings.ts).
 */

import { CoreError } from "../errors.ts";
import type {
  WebSearchSettingsView,
  WebSearchTestView,
} from "../shared/web-search.ts";
import {
  addWebSearchProvider,
  availableProviderIds,
  configuredProviderIds,
  createWebSearchManager,
  type FetchLike,
  isWebSearchProviderId,
  normalizeApiKey,
  providerInfo,
  removeWebSearchProvider,
  setDefaultWebSearchProvider,
  updateWebSearchProvider,
  type WebSearchManager,
  type WebSearchProviderId,
  type WebSearchSettingsStore,
} from "../websearch/mod.ts";
import type { Locale } from "../shared/i18n/mod.ts";

export interface WebSearchServiceOptions {
  settings: WebSearchSettingsStore;
  /** The app language: the reason a key check failed is shown to the user. */
  locale: () => Locale;
  /** Tests replace the transport so a check never reaches the network. */
  fetch?: FetchLike;
}

export class WebSearchService {
  private readonly settings: WebSearchSettingsStore;
  private readonly manager: WebSearchManager;

  constructor(options: WebSearchServiceOptions) {
    this.settings = options.settings;
    this.manager = createWebSearchManager({
      settings: options.settings,
      locale: options.locale,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
  }

  /** The provider the agent searches with, or null when none is usable. Read
   * on every session open and on every tool call's creation, so a change
   * applies to the sessions opened after it. */
  provider() {
    return this.manager.provider();
  }

  /** The setting the screen renders. */
  view(): WebSearchSettingsView {
    const stored = this.settings.read();
    return {
      defaultId: stored.defaultId,
      providers: configuredProviderIds(stored).map((id) => ({
        ...providerInfo(id),
        hasApiKey: (stored.providers.get(id)?.apiKey ?? "").length > 0,
        isDefault: stored.defaultId === id,
      })),
      available: availableProviderIds(stored).map((id) => providerInfo(id)),
    };
  }

  /** Add a provider. The first one added becomes the default, so adding a
   * single provider yields working search without a second step. */
  add(input: { id: string; apiKey: string }): WebSearchSettingsView {
    const id = requireProviderId(input.id);
    const current = this.settings.read();
    if (current.providers.has(id)) {
      throw new CoreError(
        `Search provider "${id}" is already configured`,
        "invalid",
      );
    }
    this.settings.write(
      addWebSearchProvider(current, id, requireApiKey(input.apiKey)),
    );
    return this.view();
  }

  /** Replace a provider's key. An empty input keeps the stored key, so the
   * screen can edit a provider without holding the secret. */
  update(id: string, input: { apiKey: string }): WebSearchSettingsView {
    const providerId = requireProviderId(id);
    const current = this.settings.read();
    const stored = current.providers.get(providerId);
    if (stored === undefined) {
      throw new CoreError(`Search provider not found: ${id}`, "not_found");
    }
    const apiKey = input.apiKey.trim().length === 0
      ? stored.apiKey
      : requireApiKey(input.apiKey);
    this.settings.write(updateWebSearchProvider(current, providerId, apiKey));
    return this.view();
  }

  /** Remove a provider; the default moves to the next one when it was the
   * default. */
  remove(id: string): WebSearchSettingsView {
    const providerId = requireProviderId(id);
    const current = this.settings.read();
    if (!current.providers.has(providerId)) {
      throw new CoreError(`Search provider not found: ${id}`, "not_found");
    }
    this.settings.write(removeWebSearchProvider(current, providerId));
    return this.view();
  }

  /** Choose the provider search uses; null turns search off (the tools then
   * leave every session on its next open). */
  setDefault(id: string | null): WebSearchSettingsView {
    const current = this.settings.read();
    if (id === null) {
      this.settings.write(setDefaultWebSearchProvider(current, null));
      return this.view();
    }
    const providerId = requireProviderId(id);
    if (!current.providers.has(providerId)) {
      throw new CoreError(`Search provider not found: ${id}`, "not_found");
    }
    this.settings.write(setDefaultWebSearchProvider(current, providerId));
    return this.view();
  }

  /** Search once with a key the user typed, saving nothing: the screen
   * checks before it stores. A failure is the answer, not an exception (the
   * same contract as an MCP server test). */
  test(input: {
    id: string;
    apiKey: string | null;
  }): Promise<WebSearchTestView> {
    const id = requireProviderId(input.id);
    const stored = this.settings.read().providers.get(id)?.apiKey ?? "";
    const apiKey = (input.apiKey ?? stored).trim();
    return this.manager.testKey({ id, apiKey });
  }
}

/** A provider id from a request; `invalid` when this build lacks it. */
function requireProviderId(id: string): WebSearchProviderId {
  if (!isWebSearchProviderId(id)) {
    throw new CoreError(`Unknown web search provider: ${id}`, "invalid");
  }
  return id;
}

/** A key the user typed, trimmed and non-empty. Nothing else is validated:
 * a key is opaque, and the check before saving is what says whether it
 * works. */
function requireApiKey(apiKey: string): string {
  const key = normalizeApiKey(apiKey);
  if (key.length === 0) {
    throw new CoreError("The API key must not be empty", "invalid");
  }
  return key;
}
