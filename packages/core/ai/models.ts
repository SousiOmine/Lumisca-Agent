/**
 * The Lumisca model/provider registry: owns the {@link Provider} entries and
 * resolves credentials for requests. This replaces pi-ai's `Models`/MutableModels
 * collection. Providers are Lumisca-typed; the actual LLM calls go through the
 * Vercel-backed StreamFn built by {@link buildStreamFn}.
 */
import { createStreamFn, type StreamTransport } from "./stream.ts";
import { languageModelFor, type ResolvedApiKey } from "./lang-model.ts";
import type {
  AuthCheck,
  AuthInteraction,
  AuthType,
  Credential,
  CredentialStore,
  Model,
  Provider,
  StreamFn,
} from "./types.ts";

export interface LumiscaModelsOptions {
  credentials?: CredentialStore;
  env?: () => Record<string, string | undefined>;
}

/**
 * A runtime collection of providers plus credential resolution. Providers own
 * model catalogs; this resolves auth and builds the stream function used by
 * the agent loop and the auxiliary calls.
 */
export class LumiscaModels {
  private readonly providers = new Map<string, Provider>();
  private readonly credentials: CredentialStore | undefined;
  private readonly env: () => Record<string, string | undefined>;
  private cachedStreamFn?: ReturnType<typeof createStreamFn>;

  constructor(options: LumiscaModelsOptions = {}) {
    this.credentials = options.credentials;
    this.env = options.env ?? (() => ({ ...Deno.env.toObject() }));
  }

  setProvider(provider: Provider): void {
    this.providers.set(provider.id, provider);
  }

  deleteProvider(providerId: string): void {
    this.providers.delete(providerId);
  }

  getProvider(providerId: string): Provider | undefined {
    return this.providers.get(providerId);
  }

  getProviders(): readonly Provider[] {
    return [...this.providers.values()];
  }

  getModel(providerId: string, modelId: string): Model | undefined {
    return this.providers.get(providerId)?.getModels().find((m) => m.id === modelId);
  }

  getModels(providerId?: string): readonly Model[] {
    if (providerId === undefined) {
      const out: Model[] = [];
      for (const p of this.providers.values()) out.push(...p.getModels());
      return out;
    }
    return this.providers.get(providerId)?.getModels() ?? [];
  }

  /** The stored credential of a provider (used for the configured check). */
  async getAuth(providerId: string): Promise<Credential | undefined> {
    return await this.credentials?.read(providerId);
  }

  /** Resolve the effective credential of a provider (env or stored). */
  async checkAuth(providerId: string): Promise<AuthCheck | undefined> {
    const result = await this.resolveKey(providerId);
    if (result === undefined) return undefined;
    return { source: result.source, type: "api_key" };
  }

  /** Run a provider login flow (api_key or oauth) and persist the credential. */
  async login(
    providerId: string,
    type: AuthType,
    interaction: AuthInteraction,
  ): Promise<Credential> {
    const provider = this.providers.get(providerId);
    if (provider === undefined) {
      throw new Error(`Provider not found: ${providerId}`);
    }
    const auth = type === "oauth" ? provider.auth.oauth : provider.auth.apiKey;
    const login = auth?.login;
    if (login === undefined) {
      throw new Error(`Provider ${providerId} does not support ${type} login`);
    }
    const credential = await login(interaction);
    if (this.credentials !== undefined) {
      const stored = this.credentials.modify(providerId, () => Promise.resolve(credential));
      await stored;
    }
    return credential;
  }

  /** Remove the stored credential of a provider. */
  async logout(providerId: string): Promise<void> {
    await this.credentials?.delete(providerId);
  }

  /** The StreamFn over this registry (cached). Requests for a provider with
   * a `customStream` (test doubles) route through it; everything else uses
   * the Vercel AI SDK transport. */
  streamFn(): StreamFn {
    if (this.cachedStreamFn === undefined) {
      const vercelStream = createStreamFn(this.transport());
      this.cachedStreamFn = (model, context, options) => {
        const provider = this.providers.get(model.provider);
        if (provider?.customStream !== undefined) {
          return provider.customStream(model, context, options);
        }
        return vercelStream(model, context, options);
      };
    }
    return this.cachedStreamFn;
  }

  private transport(): StreamTransport {
    return {
      languageModelFor: async (model) => {
        const key = await this.resolveKey(model.provider);
        if (key === undefined) return undefined;
        return languageModelFor(model, key);
      },
    };
  }

  /** Resolve an API key for a provider (env var or stored credential). */
  private async resolveKey(providerId: string): Promise<ResolvedApiKey | undefined> {
    const provider = this.providers.get(providerId);
    if (provider === undefined) return undefined;
    const credential = await this.credentials?.read(providerId);
    const result = await provider.resolveCredential({
      credential,
      env: this.env(),
    });
    if (result === undefined) return undefined;
    return { apiKey: result.auth.apiKey, source: result.source ?? "stored" };
  }
}
