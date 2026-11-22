import { CoreError } from "../errors.ts";
import type { CatalogStore } from "./catalog-store.ts";
import type { ProviderCredentials } from "./provider-credentials.ts";
import type {
  UserProviderConfig,
  UserProviderInput,
  UserProviderSummary,
} from "./user-providers.ts";
import { parseUserProviderInput } from "./user-providers.ts";

/**
 * The user-defined OpenAI-compatible providers as the settings UI edits them:
 * the stored config (see CatalogStore) and the API key that is never stored
 * beside it (see ProviderCredentials) changed together, so a provider the
 * caller can list is one the registry already serves.
 */
export class UserProviderAdmin {
  constructor(
    private readonly catalog: CatalogStore,
    private readonly credentials: ProviderCredentials,
  ) {}

  /** Every user-defined provider (with `hasApiKey`, never the key itself). */
  async list(): Promise<UserProviderSummary[]> {
    const out: UserProviderSummary[] = [];
    for (const config of this.catalog.userProviderConfigs()) {
      out.push(await this.summarize(config));
    }
    return out;
  }

  /** A single user-defined provider config (for prefilling an edit form),
   * or undefined when it does not exist. */
  get(id: string): UserProviderConfig | undefined {
    return this.catalog.userProviderConfig(id);
  }

  /** Create a user-defined provider. Validates the input, persists it,
   * registers it with the registry, and — when an `apiKey` was supplied —
   * stores it in the credential store. Returns the summary. */
  async add(input: UserProviderInput): Promise<UserProviderSummary> {
    const parsed = parseUserProviderInput(input);
    this.catalog.applyUserProvider(parsed);
    this.catalog.markUserProvider(parsed.id);
    if (parsed.apiKey) {
      await this.credentials.setApiKey(parsed.id, parsed.apiKey);
    }
    return await this.summarize(parsed);
  }

  /** Update a user-defined provider (id is fixed by the route). Validates
   * the input, persists and re-registers it. An `apiKey` of `""` clears the
   * stored key; a non-empty `apiKey` replaces it; an omitted `apiKey` leaves
   * the existing key untouched. Returns the summary. */
  async update(
    id: string,
    input: UserProviderInput,
  ): Promise<UserProviderSummary> {
    if (!this.catalog.userProviderConfig(id)) {
      throw new CoreError(`User provider not found: ${id}`, "not_found");
    }
    const parsed = parseUserProviderInput(
      { ...input, id },
      {
        requireId: true,
      },
    );
    this.catalog.applyUserProvider(parsed);
    if (parsed.apiKey !== undefined) {
      if (parsed.apiKey === "") await this.credentials.remove(id);
      else await this.credentials.setApiKey(id, parsed.apiKey);
    }
    return await this.summarize(parsed);
  }

  /** Remove a user-defined provider, unregister it from the registry, and
   * delete any stored API key. */
  async remove(id: string): Promise<void> {
    if (!this.catalog.userProviderConfig(id)) {
      throw new CoreError(`User provider not found: ${id}`, "not_found");
    }
    this.catalog.dropUserProvider(id);
    await this.credentials.remove(id);
  }

  private async summarize(
    config: UserProviderConfig,
  ): Promise<UserProviderSummary> {
    return {
      ...config,
      hasApiKey: await this.credentials.hasApiKey(config.id),
    };
  }
}
