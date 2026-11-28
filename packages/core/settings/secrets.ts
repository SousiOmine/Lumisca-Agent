/**
 * Secrets at rest.
 *
 * The settings file is a plain JSON document under the user's config
 * directory: it is read by hand, copied by backups and synced by whatever
 * the user runs on that folder. An API key written there as text is readable
 * by every one of those paths. This module encrypts the entries that hold a
 * credential, so the file alone no longer carries the key.
 *
 * The cipher is AES-256-GCM with a fresh 12-byte IV per write. The setting
 * key is the additional authenticated data, so a ciphertext moved to another
 * entry fails to decrypt instead of silently becoming that entry's value.
 * Values are stored as:
 *
 *   enc.v1.<base64url(iv | ciphertext | 16-byte tag)>
 *
 * The master key comes from whichever provider the installation has:
 * LUMISCA_SECRET_KEY, a systemd credential, an explicit key file, or
 * <settings dir>/secret.key created on first use. The key file is the
 * weakest provider — a backup of the config directory copies it beside the
 * ciphertext — so it is a fallback, not the recommended one. The desktop
 * shell supplies a key from the OS keychain through LUMISCA_SECRET_KEY.
 *
 * Encryption at rest does not defend against a process running as the same
 * user: it can read the key, the process environment or the settings API.
 * It defends against the file being copied somewhere else.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CoreError } from "../errors.ts";
import { atomicWriteTextFileSync } from "../fs.ts";
import { createLogger } from "../log.ts";
import { MCP_OAUTH_KEY_PREFIX } from "../mcp/oauth.ts";
import type { EnvReader } from "../models/custom.ts";
import { safeJsonParse } from "../shared/misc.ts";
import {
  AGENT_MCP_SETTINGS_PREFIX,
  APP_MCP_SETTINGS_KEY,
  COMPUTER_USE_SESSION_TOKEN_KEY,
  CONNECTIONS_KEY,
  PUSH_SUBSCRIPTIONS_KEY,
  PUSH_VAPID_KEY,
  USER_PROVIDERS_KEY,
  WEB_SEARCH_KEY,
} from "../shared/settings-keys.ts";
import { CREDENTIAL_KEY_PREFIX } from "./credentials.ts";
import type { SettingsRepo } from "./repo.ts";

const log = createLogger("settings");

/** Bytes in a master key (AES-256). */
export const SECRET_KEY_BYTES = 32;

/** Marks an encrypted value. The version suffix allows a future cipher
 * without guessing what an older value means. */
export const SECRET_CIPHER_PREFIX = "enc.v1.";

/** File name of the fallback key, created beside the settings file. */
export const SECRET_KEY_FILENAME = "secret.key";

/** The master key as base64 text, for a shell that passes it to the server. */
export const SECRET_KEY_ENV = "LUMISCA_SECRET_KEY";

/** A path to a key file, for a headless install that keeps the key elsewhere. */
export const SECRET_KEY_FILE_ENV = "LUMISCA_SECRET_KEY_FILE";

/** systemd sets this for a unit that uses LoadCredential=. */
export const CREDENTIALS_DIRECTORY_ENV = "CREDENTIALS_DIRECTORY";

/** The credential's file name inside $CREDENTIALS_DIRECTORY. */
export const CREDENTIALS_KEY_FILENAME = "lumisca-secret";

/** AAD bound to every ciphertext, so the same plaintext under another
 * setting key produces a different tag. */
const AAD_PREFIX = "lumisca-settings:v1:";

const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Settings entries that hold a credential or a capability. Everything not
 * listed here stays readable in the file: the settings file is documented as
 * hand-editable, and only the secrets need to be opaque.
 *
 * Keep this list in step with protectedKeyReason in guard.ts and the comment
 * in shared/settings-keys.ts. */
export function isSecretSettingsKey(key: string): boolean {
  return (
    key.startsWith(CREDENTIAL_KEY_PREFIX) ||
    key.startsWith(MCP_OAUTH_KEY_PREFIX) ||
    key === APP_MCP_SETTINGS_KEY ||
    key.startsWith(AGENT_MCP_SETTINGS_PREFIX) ||
    key === WEB_SEARCH_KEY ||
    key === CONNECTIONS_KEY ||
    key === USER_PROVIDERS_KEY ||
    key === COMPUTER_USE_SESSION_TOKEN_KEY ||
    key === PUSH_VAPID_KEY ||
    key === PUSH_SUBSCRIPTIONS_KEY
  );
}

/** Whether a stored value is already ciphertext. */
export function isEncryptedSecret(value: string): boolean {
  return value.startsWith(SECRET_CIPHER_PREFIX);
}

/** Encrypt and decrypt one settings entry. */
export interface SecretBox {
  /** Encrypt `plaintext` for the setting named `settingKey`. */
  encrypt(settingKey: string, plaintext: string): string;
  /** Decrypt a stored value, or undefined when it cannot be read with this
   * key (a different key, a truncated value, a moved ciphertext). */
  decrypt(settingKey: string, stored: string): string | undefined;
}

function aadFor(settingKey: string): Buffer {
  return Buffer.from(`${AAD_PREFIX}${settingKey}`, "utf8");
}

/** Bind clamps to one master key. Throws when the key is not 32 bytes. */
export function createSecretBox(masterKey: Uint8Array): SecretBox {
  if (masterKey.length !== SECRET_KEY_BYTES) {
    throw new CoreError(
      `The secret key must be ${SECRET_KEY_BYTES} bytes (got ${masterKey.length})`,
      "invalid",
    );
  }
  const key = Buffer.from(masterKey);
  return {
    encrypt(settingKey: string, plaintext: string): string {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(aadFor(settingKey));
      const body = Buffer.concat([
        cipher.update(plaintext, "utf8"),
        cipher.final(),
      ]);
      const tag = cipher.getAuthTag();
      return (
        SECRET_CIPHER_PREFIX +
        Buffer.concat([iv, body, tag]).toString("base64url")
      );
    },
    decrypt(settingKey: string, stored: string): string | undefined {
      if (!isEncryptedSecret(stored)) return undefined;
      const raw = Buffer.from(
        stored.slice(SECRET_CIPHER_PREFIX.length),
        "base64url",
      );
      if (raw.length < IV_BYTES + TAG_BYTES) return undefined;
      const iv = raw.subarray(0, IV_BYTES);
      const tag = raw.subarray(raw.length - TAG_BYTES);
      const body = raw.subarray(IV_BYTES, raw.length - TAG_BYTES);
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, iv);
        decipher.setAAD(aadFor(settingKey));
        decipher.setAuthTag(tag);
        return Buffer.concat([
          decipher.update(body),
          decipher.final(),
        ]).toString("utf8");
      } catch {
        // A wrong key or a tampered value is "unreadable", not a crash: the
        // entry reads as unset and the user can enter the key again.
        return undefined;
      }
    },
  };
}

/** A random key for an in-memory store: credentials work for the lifetime of
 * the process and are never written anywhere. */
export function createEphemeralSecretBox(): SecretBox {
  return createSecretBox(randomBytes(SECRET_KEY_BYTES));
}

/** Read a key file whose content is base64. */
export function readSecretKeyFile(path: string): Uint8Array {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new CoreError(
      `Cannot read the secret key file ${path}: ${String(error)}`,
      "invalid",
    );
  }
  return parseSecretKey(text, path);
}

/** Parse base64 or base64url key text. */
export function parseSecretKey(text: string, source: string): Uint8Array {
  const compact = text
    .replace(/\s+/g, "")
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const normalized =
    compact.length % 4 === 0
      ? compact
      : compact.padEnd(compact.length + (4 - (compact.length % 4)), "=");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    throw new CoreError(
      `The secret key in ${source} is not base64 text`,
      "invalid",
    );
  }
  const bytes = Buffer.from(normalized, "base64");
  if (bytes.length !== SECRET_KEY_BYTES) {
    throw new CoreError(
      `The secret key in ${source} must be ${SECRET_KEY_BYTES} bytes encoded as base64 (got ${bytes.length})`,
      "invalid",
    );
  }
  return new Uint8Array(bytes);
}

/** Where a resolved master key came from. */
export type SecretKeySource =
  | "env"
  | "credentials"
  | "key-file"
  | "settings-key-file"
  | "ephemeral";

export interface ResolvedSecretKey {
  key: Uint8Array;
  source: SecretKeySource;
  /** The file the key was read from or created at, when there is one. */
  location?: string;
}

/** Load a key file, creating it with mode 0600 when it does not exist. */
function loadOrCreateKeyFile(path: string): Uint8Array {
  if (existsSync(path)) return readSecretKeyFile(path);
  const key = randomBytes(SECRET_KEY_BYTES);
  atomicWriteTextFileSync(path, `${key.toString("base64")}\n`, {
    mode: 0o600,
  });
  log.warn(
    `created a secret key at ${path}; set ${SECRET_KEY_ENV} or a systemd ` +
      `credential to keep the key out of the config directory`,
  );
  return new Uint8Array(key);
}

/** Resolve the master key for this installation.
 *
 * Order: LUMISCA_SECRET_KEY, $CREDENTIALS_DIRECTORY/lumisca-secret,
 * LUMISCA_SECRET_KEY_FILE, then <settings dir>/secret.key. The last one is
 * created on first use, so a fresh install works without configuration.
 * An in-memory install has no directory and gets a key that exists only for
 * the life of the process. */
export function resolveMasterKey(
  settingsDir: string | undefined,
  env: EnvReader,
  capturedKey?: string,
): ResolvedSecretKey {
  // A launcher that consumed LUMISCA_SECRET_KEY from its own environment
  // passes the value here: the variable is gone by the time this runs (see
  // packages/server/startup-env.ts), and it must not reach child processes.
  if (capturedKey !== undefined && capturedKey.trim().length > 0) {
    return {
      key: parseSecretKey(capturedKey, SECRET_KEY_ENV),
      source: "env",
    };
  }
  const values = env();
  const inline = values[SECRET_KEY_ENV]?.trim();
  if (inline !== undefined && inline.length > 0) {
    return { key: parseSecretKey(inline, SECRET_KEY_ENV), source: "env" };
  }

  const credentialsDir = values[CREDENTIALS_DIRECTORY_ENV]?.trim();
  if (credentialsDir !== undefined && credentialsDir.length > 0) {
    const path = join(credentialsDir, CREDENTIALS_KEY_FILENAME);
    if (existsSync(path)) {
      return {
        key: readSecretKeyFile(path),
        source: "credentials",
        location: path,
      };
    }
  }

  const explicit = values[SECRET_KEY_FILE_ENV]?.trim();
  if (explicit !== undefined && explicit.length > 0) {
    return {
      key: loadOrCreateKeyFile(explicit),
      source: "key-file",
      location: explicit,
    };
  }

  if (settingsDir !== undefined) {
    const path = join(settingsDir, SECRET_KEY_FILENAME);
    return {
      key: loadOrCreateKeyFile(path),
      source: "settings-key-file",
      location: path,
    };
  }

  return { key: randomBytes(SECRET_KEY_BYTES), source: "ephemeral" };
}

/** Wrap a settings store so secret entries are ciphertext at rest.
 *
 * Reads of a legacy plaintext value still work; {@link migratePlaintextSecrets}
 * rewrites them on the first open. A value that cannot be decrypted reads as
 * undefined instead of failing the whole store, and is reported once. */
export function createEncryptedSettingsRepo(
  inner: SettingsRepo,
  box: SecretBox,
): SettingsRepo {
  const warned = new Set<string>();
  const decrypt = (key: string, value: string): string | undefined => {
    if (!isSecretSettingsKey(key)) return value;
    if (!isEncryptedSecret(value)) return value;
    const plain = box.decrypt(key, value);
    if (plain === undefined && !warned.has(key)) {
      warned.add(key);
      log.warn(
        `could not decrypt "${key}"; it reads as unset until it is written again`,
      );
    }
    return plain;
  };
  const get = (key: string): string | undefined => {
    const value = inner.get(key);
    return value === undefined ? undefined : decrypt(key, value);
  };
  const set = (key: string, value: string): void => {
    inner.set(key, isSecretSettingsKey(key) ? box.encrypt(key, value) : value);
  };
  return {
    get,
    set,
    getJson<T>(key: string): T | undefined {
      return safeJsonParse<T>(get(key));
    },
    setJson(key: string, value: unknown): void {
      set(key, JSON.stringify(value));
    },
    delete(key: string): void {
      inner.delete(key);
    },
    list(): Map<string, string> {
      const out = new Map<string, string>();
      for (const [key, value] of inner.list()) {
        const plain = decrypt(key, value);
        if (plain !== undefined) out.set(key, plain);
      }
      return out;
    },
    dir(): string | undefined {
      return inner.dir();
    },
  };
}

/** Encrypt every secret still stored as plaintext in `store`. Returns how
 * many entries were rewritten. Idempotent: a value already prefixed with
 * SECRET_CIPHER_PREFIX is left alone.
 *
 * This takes the RAW store, not the encrypted wrapper: reading through the
 * wrapper returns plaintext for ciphertext, so it cannot tell the two apart. */
export function migratePlaintextSecrets(
  store: SettingsRepo,
  box: SecretBox,
): number {
  let migrated = 0;
  for (const [key, value] of store.list()) {
    if (!isSecretSettingsKey(key)) continue;
    if (isEncryptedSecret(value)) continue;
    store.set(key, box.encrypt(key, value));
    migrated += 1;
  }
  return migrated;
}
