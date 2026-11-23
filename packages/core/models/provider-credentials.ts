import type {
  AuthCheck,
  AuthInteraction,
  AuthType,
  Credential,
  CredentialStore,
} from "../ai/catalog.ts";
import type { LumiscaModels } from "../ai/models.ts";
import { setApiKey } from "../settings/credentials.ts";

/**
 * What a provider's credential means: logging in through the provider's own
 * flow, storing or removing the key, and the two "is this provider usable"
 * answers the settings list, the pickers and the default-model resolution
 * ask.
 *
 * The rules live here because they are about a CREDENTIAL, not about the
 * catalog: a stored key/OAuth grant means configured, and for Lumisca's own
 * custom providers a resolvable env var counts too — an ambient key the SDK
 * happens to find for a built-in provider does not.
 */
export class ProviderCredentials {
  constructor(
    private readonly models: LumiscaModels,
    private readonly store: CredentialStore,
    /** Whether the id comes from Lumisca's own config rather than the SDK's
     * catalog (see CatalogStore.isCustomProvider). */
    private readonly isCustomProvider: (providerId: string) => boolean,
  ) {}

  /** Run a provider-owned login flow (e.g. OAuth) and persist the returned
   * credential. The interaction bridges the flow's prompts and
   * notifications to whoever drives the UI. */
  login(
    providerId: string,
    type: AuthType,
    interaction: AuthInteraction,
  ): Promise<Credential> {
    return this.models.login(providerId, type, interaction);
  }

  /** Remove the stored credential for a provider. Resolves to a warning
   * when the provider-side session could not be revoked. */
  logout(providerId: string): Promise<string | undefined> {
    return this.models.logout(providerId);
  }

  /** Replace a provider's stored API key. The credential store is the model
   * layer's (a key belongs to a provider, not to the settings table), so a
   * caller that may write keys uses this instead of reaching into
   * settings/credentials.ts with a store it does not own. */
  async setApiKey(providerId: string, key: string): Promise<void> {
    await setApiKey(this.store, providerId, key);
  }

  /** Delete whatever credential a provider has stored (a removed
   * user-defined provider takes its key with it). */
  async remove(providerId: string): Promise<void> {
    await this.store.delete(providerId);
  }

  /** Whether a usable API key is stored for the provider (the settings
   * list's `hasApiKey`, which never carries the key itself). */
  async hasApiKey(providerId: string): Promise<boolean> {
    const credential = await this.store.read(providerId);
    return credential?.type === "api_key" && credential.key !== "";
  }

  async checkAuth(providerId: string): Promise<AuthCheck | undefined> {
    return await this.models.checkAuth(providerId);
  }

  /** Whether the provider resolves auth (env var or stored key) without a
   * network call — the runtime capability check. Unlike
   * `hasConfiguredAuth`, ambient env keys of built-in providers count. */
  async hasProviderAuth(providerId: string): Promise<boolean> {
    return (await this.models.checkAuth(providerId)) !== undefined;
  }

  /** Whether the provider is set up inside Lumisca itself: an API key or
   * OAuth credential stored here, or a custom provider from Lumisca's own
   * config (models.json / LUMISCA_* env vars, a user-defined provider)
   * whose auth resolves. Ambient machine auth that the SDK happens to find
   * — e.g. ANTHROPIC_API_KEY or HF_TOKEN set for other tools — does NOT
   * count: providers must not appear as "added" just because an env var
   * exists. This is the same verdict the settings list, the pickers and
   * the default-model resolution use. */
  async hasConfiguredAuth(providerId: string): Promise<boolean> {
    if ((await this.store.read(providerId)) !== undefined) {
      return true;
    }
    return (
      this.isCustomProvider(providerId) &&
      (await this.hasProviderAuth(providerId))
    );
  }
}
