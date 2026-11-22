import { systemLanguageTags } from "../locale.ts";
import type { CommandSafety } from "../safety/command-safety.ts";
import {
  type ConnectionEntry,
  parseConnections,
} from "../settings/connections.ts";
import {
  assertMutableKey,
  assertNotProtected,
  filterExposedSettings,
} from "../settings/guard.ts";
import type { SettingsRepo } from "../settings/repo.ts";
import { markSetupComplete, readSetupState } from "../settings/setup.ts";
import type {
  CommandApproval,
  CompactionPolicyInput,
  Locale,
  SetupState,
} from "../shared/mod.ts";
import {
  CONNECTIONS_KEY,
  LANGUAGE_KEY,
  parseCompactionPolicyInput,
  resolveLocale,
  stellaKeepsFullLog,
} from "../shared/mod.ts";

/** What the settings service reads from the installation. The repository is
 * the stored file (or its in-memory twin); the directory is where the
 * first-run marker lives; the safety check owns the approvals record. */
export interface SettingsServiceDeps {
  repo: SettingsRepo;
  settingsDir: string | undefined;
  commandSafety: CommandSafety;
}

/**
 * The installation's settings: the key-value file, the first-run marker, the
 * language derived from it, the compaction tuning, the command-safety
 * approvals and the server-side federation peers.
 *
 * This is the guarded surface. Credentials and MCP configuration are
 * protected keys: they have their own APIs and must never be readable
 * through the generic settings route. Services that own their keys read the
 * repository directly, before this guard applies.
 */
export class SettingsService {
  readonly #deps: SettingsServiceDeps;

  constructor(deps: SettingsServiceDeps) {
    this.#deps = deps;
  }

  /** Read a setting. Protected keys are refused. */
  get(key: string): string | undefined {
    assertNotProtected(key);
    return this.#deps.repo.get(key);
  }

  /** Write a setting, for the server and the core's own services. Every
   * unprotected key is accepted; client writes go through `setUser`. */
  set(key: string, value: string): void {
    assertNotProtected(key);
    this.#deps.repo.set(key, value);
  }

  /** Write a preference on behalf of a client. In addition to the
   * protection check, only the keys declared in settings/guard.ts are
   * accepted: the settings file is shared by many owners, so a key a client
   * invented must not become a permanent dead entry. The protection check
   * runs first, so a credential key is refused as forbidden (403) rather
   * than as an unknown preference (400). */
  setUser(key: string, value: string): void {
    assertNotProtected(key);
    assertMutableKey(key);
    this.#deps.repo.set(key, value);
  }

  remove(key: string): void {
    assertNotProtected(key);
    this.#deps.repo.delete(key);
  }

  /** Non-protected settings only; credentials, MCP config, the federation
   * peer registry and the command-safety approvals record are never exposed
   * through the generic settings surface. */
  list(): Map<string, string> {
    return filterExposedSettings(this.#deps.repo.list());
  }

  /** Whether this installation's first-run setup is done (see
   * settings/setup.ts: a marker file beside the settings file).
   *
   * Read on every call instead of once at startup on purpose: the marker is
   * how a reader asks for the wizard again, and an answer cached for the life
   * of the process would make them restart the server to see it. */
  setup(): SetupState {
    return readSetupState(this.#deps.settingsDir);
  }

  /** Record that the first-run setup finished, by writing its marker. */
  completeSetup(): SetupState {
    return markSetupComplete(this.#deps.settingsDir);
  }

  /** The app language: the stored setting when one was chosen, else the
   * machine's own locale (see shared/i18n and locale.ts). The server
   * resolves the same value per request — its first page load stores the
   * browser's language — so both agree on what "the app language" is.
   *
   * It is read when a session is created (the prompt and the provisional
   * name) and when a session agent is built (the language of the text the
   * core generates into the transcript). */
  language(): Locale {
    return resolveLocale(
      this.#deps.repo.get(LANGUAGE_KEY),
      systemLanguageTags(),
    );
  }

  /** The compaction tuning stored in the settings table (see
   * shared/settings-keys.ts). Read by the session agents on every
   * compaction check, so a change applies to running sessions without a
   * rebuild; omitted fields keep the compactor's defaults (pi's). */
  compactionPolicy(): CompactionPolicyInput {
    return parseCompactionPolicyInput((key) => this.#deps.repo.get(key));
  }

  /** Whether stella conversations keep their whole transcript (see
   * STELLA_KEEP_FULL_LOG_KEY). Read by the session agents on every prune,
   * so the settings toggle reaches a running conversation. */
  stellaKeepsFullLog(): boolean {
    return stellaKeepsFullLog((key) => this.#deps.repo.get(key));
  }

  /** The recorded approvals of the safety check, in insertion order. Each
   * entry carries a redacted command for display (never the raw command),
   * so it is safe to surface to the UI. */
  commandApprovals(): CommandApproval[] {
    return this.#deps.commandSafety.approvals();
  }

  /** Forget one approval by its hash (it is judged again next time). */
  deleteCommandApproval(hash: string): void {
    this.#deps.commandSafety.deleteApproval(hash);
  }

  /** Forget every approved command. */
  clearCommandApprovals(): void {
    this.#deps.commandSafety.clearApprovals();
  }

  /** The server-side federation peers (see FederationClient). The desktop
   * app's own server list lives in the shell, not here; no client route
   * exposes this one. */
  connections(): ConnectionEntry[] {
    return parseConnections(this.#deps.repo.get(CONNECTIONS_KEY));
  }

  setConnections(entries: ConnectionEntry[]): void {
    this.#deps.repo.setJson(CONNECTIONS_KEY, entries);
  }
}
