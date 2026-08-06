import type {
  ApiKeyCredential,
  Credential,
  CredentialInfo,
  CredentialStore,
} from "npm:@earendil-works/pi-ai@0.83.0";
import type { SettingsRepo } from "./repo.ts";

const KEY_PREFIX = "api_key:";

/**
 * CredentialStore backed by the settings table.
 *
 * Keys are namespaced (`api_key:<providerId>`) so credentials and
 * application settings share the settings table without colliding.
 */
export function createDbCredentialStore(settings: SettingsRepo): CredentialStore {
  function read(providerId: string): Credential | undefined {
    const raw = settings.get(`${KEY_PREFIX}${providerId}`);
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as Credential;
    } catch {
      return undefined;
    }
  }

  return {
    async read(providerId: string): Promise<Credential | undefined> {
      return read(providerId);
    },
    async list(): Promise<readonly CredentialInfo[]> {
      const infos: CredentialInfo[] = [];
      for (const [key, value] of settings.list()) {
        if (!key.startsWith(KEY_PREFIX)) continue;
        const providerId = key.slice(KEY_PREFIX.length);
        try {
          const credential = JSON.parse(value) as Credential;
          infos.push({ providerId, type: credential.type });
        } catch {
          // ignore malformed entries
        }
      }
      return infos;
    },
    async modify(
      providerId: string,
      fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    ): Promise<Credential | undefined> {
      const current = read(providerId);
      const next = await fn(current);
      if (next === undefined) {
        settings.delete(`${KEY_PREFIX}${providerId}`);
      } else {
        settings.set(`${KEY_PREFIX}${providerId}`, JSON.stringify(next));
      }
      return next;
    },
    async delete(providerId: string): Promise<void> {
      settings.delete(`${KEY_PREFIX}${providerId}`);
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
  await store.modify(providerId, async () => credential);
}

export async function getApiKey(
  store: CredentialStore,
  providerId: string,
): Promise<string | undefined> {
  const credential = await store.read(providerId);
  if (credential?.type === "api_key") return credential.key;
  return undefined;
}
