import type {
  ApiKeyCredential,
  Credential,
  CredentialInfo,
  CredentialStore,
} from "@earendil-works/pi-ai";
import type { SettingsRepo } from "./repo.ts";

/** Settings-file key prefix for credentials. Shared with the server layer
 * (settings API filters these keys out) — single source of truth. */
export const CREDENTIAL_KEY_PREFIX = "api_key:";

/**
 * CredentialStore backed by the settings store.
 *
 * Keys are namespaced (`api_key:<providerId>`) so credentials and
 * application settings share the settings store without colliding.
 */
export function createDbCredentialStore(
  settings: SettingsRepo,
): CredentialStore {
  function read(providerId: string): Credential | undefined {
    const raw = settings.get(`${CREDENTIAL_KEY_PREFIX}${providerId}`);
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as Credential;
    } catch {
      return undefined;
    }
  }

  return {
    read(providerId: string): Promise<Credential | undefined> {
      return Promise.resolve(read(providerId));
    },
    list(): Promise<readonly CredentialInfo[]> {
      const infos: CredentialInfo[] = [];
      for (const [key, value] of settings.list()) {
        if (!key.startsWith(CREDENTIAL_KEY_PREFIX)) continue;
        const providerId = key.slice(CREDENTIAL_KEY_PREFIX.length);
        try {
          const credential = JSON.parse(value) as Credential;
          infos.push({ providerId, type: credential.type });
        } catch {
          // ignore malformed entries
        }
      }
      return Promise.resolve(infos);
    },
    async modify(
      providerId: string,
      fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    ): Promise<Credential | undefined> {
      const current = read(providerId);
      const next = await fn(current);
      if (next === undefined) {
        settings.delete(`${CREDENTIAL_KEY_PREFIX}${providerId}`);
      } else {
        settings.set(
          `${CREDENTIAL_KEY_PREFIX}${providerId}`,
          JSON.stringify(next),
        );
      }
      return next;
    },
    delete(providerId: string): Promise<void> {
      settings.delete(`${CREDENTIAL_KEY_PREFIX}${providerId}`);
      return Promise.resolve();
    },
  };
}

/** Convenience for storing a plain API key. */
export async function setApiKey(
  store: CredentialStore,
  providerId: string,
  key: string,
): Promise<void> {
  const credential: ApiKeyCredential = { type: "api_key", key };
  await store.modify(providerId, () => Promise.resolve(credential));
}
