/**
 * The standalone server's updater: the state machine behind `/api/update/*`.
 *
 * It mirrors the desktop shell's updater (packages/desktop
 * src-tauri/src/update.rs) so both distributions offer the same experience —
 * a periodic check, an automatic download, an explicit install — with one
 * deliberate difference: applying an update never interrupts the running
 * server. The files next to the binary are replaced (which a running process
 * does not notice), and the new version takes effect at the next start. Only
 * `restart()` stops this process, and it is the user's (or an explicit
 * setting's) decision, because a restart cuts live agent sessions.
 *
 * Every side effect is injectable (fetch, the version check, the shutdown
 * and exit callbacks), so the whole state machine is testable without a
 * running server, a network, or a self-replacing binary.
 */
import { UPDATE_AUTO_KEY, UPDATE_AUTO_RESTART_KEY } from "@lumisca/core/shared";
import { SERVER_VERSION } from "../version.ts";
import {
  applyStagedUpdate,
  cleanupStaleFiles,
  type InstallEnvironment,
  startSuccessor,
  successorEnvironment,
} from "./install.ts";
import {
  defaultManifestUrl,
  isNewerVersion,
  parseReleaseManifest,
  type ReleaseManifest,
  releaseTargetFor,
} from "./release.ts";
import {
  clearStaging,
  readAppliedUpdate,
  readStagedUpdate,
  type StagedUpdate,
  stageUpdate,
} from "./stage.ts";

/** Periodic cadence, matching the desktop updater: a check shortly after
 * startup (once the UI is up) and every six hours after that. */
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const FIRST_UPDATE_CHECK_DELAY_MS = 10 * 1000;
/** How long a restart waits before stopping the server: the HTTP response
 * that requested it (and any pending UI work) must get out first. */
const RESTART_DELAY_MS = 250;
/** Bind-retry budget handed to the successor (see install.startSuccessor). */
const SUCCESSOR_PORT_WAIT_MS = 15_000;
/** Manifest fetch timeout: the release page is small, and a hung check must
 * not hold the state machine forever. */
const CHECK_TIMEOUT_MS = 30_000;

/** How an update is activated (see startup.parseUpdateRestartMode). */
export type UpdateRestartMode = "self" | "none";

/** What the updater reports to the UI (also the shape of
 * `/api/update/status`). */
export interface UpdateStatus {
  /** Whether this installation can update itself at all. */
  supported: boolean;
  /** Why it cannot (shown instead of the controls), null when supported. */
  unsupportedReason: string | null;
  currentVersion: string;
  target: string;
  /** Automatic check + download + apply (the files on disk). */
  autoUpdate: boolean;
  /** Restart automatically once an update is applied. */
  autoRestart: boolean;
  /** Whether this installation is allowed to restart itself at all. */
  restartMode: UpdateRestartMode;
  checking: boolean;
  available: boolean;
  latestVersion: string | null;
  downloading: boolean;
  /** 0..1 while downloading (null when the total size is unknown). */
  progress: number | null;
  downloaded: number | null;
  total: number | null;
  /** A verified package is staged and can be installed. */
  ready: boolean;
  /** The files on disk are a different version than the running process. */
  applied: boolean;
  appliedVersion: string | null;
  /** `applied` for a version newer than the running one: a restart finishes
   * the update. */
  restartPending: boolean;
  /** A restart is scheduled (the server is about to go away). */
  restarting: boolean;
  error: string | null;
}

/** The slice of the settings store the updater needs. */
export interface UpdateSettings {
  getSetting(key: string): string | undefined;
  setSetting(key: string, value: string): void;
}

export interface UpdateServiceOptions {
  /** Where the server binary and its assets live. */
  environment: InstallEnvironment;
  settings: UpdateSettings;
  /** Launch configuration to replay for the successor process. */
  startupEnv: Readonly<Record<string, string | undefined>>;
  /** Working directory the successor starts in. */
  cwd: string;
  /** Manifest URL (defaults to the release page of this target). */
  manifestUrl?: string;
  restartMode?: UpdateRestartMode;
  /** Defaults to the compiled-in SERVER_VERSION / Deno.build.target. */
  currentVersion?: string;
  target?: string;
  fetch?: typeof fetch;
  /** Release the running server (server shutdown + core close) before the
   * successor starts. */
  shutdown?: () => Promise<void>;
  /** Terminate this process (Deno.exit by default). */
  exit?: (code: number) => void;
  /** Release key to verify against (tests and forks pass their own). */
  publicKey?: string;
  /** Injected in tests: runs `<binary> --version`. */
  versionCheck?: (binary: string) => Promise<string>;
  /** Injected in tests: starts the successor process. */
  spawnSuccessor?: typeof startSuccessor;
  /** Injected in tests: delay before a scheduled restart. */
  restartDelayMs?: number;
  /** Injected in tests: delay before the first periodic check. */
  firstCheckDelayMs?: number;
  /** Injected in tests: cadence of the periodic check. */
  checkIntervalMs?: number;
  /** Injected in tests: retry budget handed to the successor. */
  successorPortWaitMs?: number;
}

/** Read a flag setting ("1"/"0", anything else = the default). */
function flagSetting(
  settings: UpdateSettings,
  key: string,
  fallback: boolean,
): boolean {
  const raw = settings.getSetting(key);
  if (raw === undefined || raw === "") return fallback;
  return raw === "1";
}

/**
 * The updater of one server process.
 *
 * One instance per process, created by the composition root (mod.ts) and
 * handed to the HTTP layer. Its state is written by the async actions and
 * read by the status endpoint; every action is guarded so a second click (or
 * an overlapping timer) cannot start the same work twice.
 */
export class UpdateService {
  readonly #options: UpdateServiceOptions;
  readonly #currentVersion: string;
  readonly #target: string;
  readonly #environment: InstallEnvironment;
  readonly #fetch: typeof fetch;
  readonly #restartMode: UpdateRestartMode;

  #autoUpdate: boolean;
  #autoRestart: boolean;
  #status: UpdateStatus;
  #manifest: ReleaseManifest | null = null;
  #staged: StagedUpdate | null = null;
  /** Non-null while an action owns the state machine. */
  #busy: "checking" | "downloading" | "applying" | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  /** Set by dispose(): the periodic chain is over. Checked in #tick's
   * finally so a tick that was already running cannot schedule the next one
   * (dispose is not awaited, so it can always race a tick). */
  #disposed = false;

  constructor(options: UpdateServiceOptions) {
    this.#options = options;
    this.#environment = options.environment;
    this.#currentVersion = options.currentVersion ?? SERVER_VERSION;
    this.#target = options.target ?? Deno.build.target;
    this.#fetch = options.fetch ?? fetch;
    this.#restartMode = options.restartMode ?? "self";
    this.#autoUpdate = flagSetting(options.settings, UPDATE_AUTO_KEY, true);
    this.#autoRestart = flagSetting(
      options.settings,
      UPDATE_AUTO_RESTART_KEY,
      false,
    );

    // The composition root only builds an updater for an installation that
    // may update itself (startup.updateSupport); the only unsupported case
    // left here is a target with no published server distribution.
    const unsupported = releaseTargetFor(this.#target) === undefined
      ? `この構成 (${this.#target}) 向けのサーバー配布はありません`
      : null;

    this.#status = {
      supported: unsupported === null,
      unsupportedReason: unsupported,
      currentVersion: this.#currentVersion,
      target: this.#target,
      autoUpdate: this.#autoUpdate,
      autoRestart: this.#autoRestart,
      restartMode: this.#restartMode,
      checking: false,
      available: false,
      latestVersion: null,
      downloading: false,
      progress: null,
      downloaded: null,
      total: null,
      ready: false,
      applied: false,
      appliedVersion: null,
      restartPending: false,
      restarting: false,
      error: null,
    };
    this.#reconcile();
  }

  /** Manifest URL this installation checks. */
  get manifestUrl(): string {
    return this.#options.manifestUrl ?? defaultManifestUrl(this.#target);
  }

  /** Current state, as a copy the caller may serialize. */
  status(): UpdateStatus {
    return { ...this.#status };
  }

  /**
   * Account for a staging area left by a previous process: a verified
   * package of a newer version is ready to install, an applied package means
   * a restart finishes the update, and anything else (an older package, a
   * half-updated directory) is cleaned up.
   */
  #reconcile(): void {
    if (!this.#status.supported) return;
    const applied = readAppliedUpdate(this.#environment.installDir);
    const staged = readStagedUpdate(this.#environment.installDir);
    if (
      staged !== null && staged !== undefined &&
      isNewerVersion(staged.version, this.#currentVersion)
    ) {
      this.#staged = staged;
      this.#status.ready = true;
      this.#status.available = true;
      this.#status.latestVersion = staged.version;
    } else if (staged !== undefined) {
      // An update that is no longer newer (this process is already the new
      // version, or a manual install overtook it).
      void clearStaging(this.#environment.installDir);
    }
    if (applied !== undefined && applied.version !== this.#currentVersion) {
      this.#status.applied = true;
      this.#status.appliedVersion = applied.version;
      this.#status.restartPending = isNewerVersion(
        applied.version,
        this.#currentVersion,
      );
      if (!this.#status.restartPending) {
        // Running a newer version than what the marker claims: the marker is
        // stale, not a pending update.
        this.#status.applied = false;
        this.#status.appliedVersion = null;
      }
    } else if (applied !== undefined) {
      // This process runs the applied version: the update is complete.
      void clearStaging(this.#environment.installDir);
    }
    // The previous process may have left backups behind (on Windows the
    // running binary cannot be deleted); this process is not holding them.
    void cleanupStaleFiles(this.#environment).catch(() => {});
  }

  /** Schedule the periodic check (no-op when updates are unavailable). */
  start(): void {
    if (!this.#status.supported) return;
    this.#disposed = false;
    this.#timer = setTimeout(
      () => void this.#tick(),
      this.#options.firstCheckDelayMs ?? FIRST_UPDATE_CHECK_DELAY_MS,
    );
  }

  /** Stop the periodic check (the server is shutting down). A check that is
   * already in flight finishes, but it will not schedule a successor. */
  dispose(): void {
    this.#disposed = true;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
  }

  async #tick(): Promise<void> {
    try {
      if (this.#autoUpdate) await this.check(true);
    } finally {
      // Re-arm only while the periodic chain is alive: a tick that was
      // already running when dispose() landed must not reschedule itself.
      if (!this.#disposed) {
        this.#timer = setTimeout(
          () => void this.#tick(),
          this.#options.checkIntervalMs ?? UPDATE_CHECK_INTERVAL_MS,
        );
      }
    }
  }

  /** Persist and apply the automatic-update toggle; turning it on checks
   * right away, like the desktop updater does. */
  setAuto(enabled: boolean): UpdateStatus {
    this.#options.settings.setSetting(UPDATE_AUTO_KEY, enabled ? "1" : "0");
    this.#autoUpdate = enabled;
    this.#status.autoUpdate = enabled;
    if (enabled) void this.check(true);
    return this.status();
  }

  /** Persist and apply the automatic-restart toggle. */
  setAutoRestart(enabled: boolean): UpdateStatus {
    this.#options.settings.setSetting(
      UPDATE_AUTO_RESTART_KEY,
      enabled ? "1" : "0",
    );
    this.#autoRestart = enabled;
    this.#status.autoRestart = enabled;
    if (enabled && this.#status.restartPending) void this.restart();
    return this.status();
  }

  /**
   * Look for a newer release. In auto mode (startup, the periodic timer, the
   * automatic toggle) an available update is downloaded and applied right
   * away; a manual check only records it.
   */
  async check(auto = false): Promise<UpdateStatus> {
    if (!this.#status.supported) return this.status();
    if (
      this.#busy !== null || this.#status.ready || this.#status.restartPending
    ) {
      return this.status();
    }
    this.#busy = "checking";
    this.#patch({ checking: true, error: null });
    try {
      const response = await this.#fetch(this.manifestUrl, {
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
        redirect: "follow",
      });
      if (!response.ok) {
        throw new Error(
          `更新情報を取得できませんでした (HTTP ${response.status})`,
        );
      }
      const manifest = parseReleaseManifest(
        await response.json(),
        this.#target,
      );
      this.#manifest = manifest;
      const newer = isNewerVersion(manifest.version, this.#currentVersion);
      this.#patch({
        checking: false,
        available: newer,
        latestVersion: newer ? manifest.version : null,
      });
      if (!newer) {
        // Nothing to install: whatever was pending is not newer than this
        // process after all.
        this.#manifest = null;
        this.#patch({ ready: false });
        return this.status();
      }
    } catch (error) {
      this.#fail(`更新の確認に失敗しました: ${errorMessage(error)}`);
      return this.status();
    } finally {
      this.#busy = null;
    }

    if (auto && this.#autoUpdate) return await this.download();
    return this.status();
  }

  /** Download and verify the available release. */
  async download(): Promise<UpdateStatus> {
    if (!this.#status.supported || this.#busy !== null) return this.status();
    const manifest = this.#manifest;
    if (manifest === null || !this.#status.available || this.#status.ready) {
      return this.status();
    }
    this.#busy = "downloading";
    this.#patch({
      downloading: true,
      progress: 0,
      downloaded: 0,
      total: manifest.size,
      error: null,
    });
    try {
      const staged = await stageUpdate({
        installDir: this.#environment.installDir,
        manifest,
        fetch: this.#options.fetch,
        publicKey: this.#options.publicKey,
        onProgress: ({ received, total }) => {
          this.#patch({
            downloaded: received,
            total: total ?? manifest.size,
            progress: total === undefined ? null : received / total,
          });
        },
      });
      this.#staged = staged;
      this.#patch({
        downloading: false,
        ready: true,
        progress: 1,
        latestVersion: staged.version,
      });
    } catch (error) {
      this.#fail(`更新のダウンロードに失敗しました: ${errorMessage(error)}`);
      return this.status();
    } finally {
      this.#busy = null;
    }

    if (this.#autoUpdate) return await this.apply();
    return this.status();
  }

  /**
   * Install the staged package: replace the files next to the binary. The
   * running server is unaffected — the new version starts at the next launch
   * (or immediately, when the automatic restart is enabled).
   */
  async apply(): Promise<UpdateStatus> {
    if (!this.#status.supported || this.#busy !== null) return this.status();
    const staged = this.#staged;
    if (staged === null || this.#status.restartPending) return this.status();
    this.#busy = "applying";
    this.#patch({ error: null });
    try {
      const result = await applyStagedUpdate({
        environment: this.#environment,
        staged,
        currentVersion: this.#currentVersion,
        versionCheck: this.#options.versionCheck,
      });
      this.#staged = null;
      this.#patch({
        downloading: false,
        ready: false,
        downloaded: null,
        total: null,
        progress: null,
        applied: true,
        appliedVersion: result.version,
        restartPending: result.version !== this.#currentVersion,
      });
    } catch (error) {
      this.#fail(`更新の適用に失敗しました: ${errorMessage(error)}`);
      return this.status();
    } finally {
      this.#busy = null;
    }

    if (this.#autoRestart && this.#status.restartPending) {
      return await this.restart();
    }
    return this.status();
  }

  /**
   * Restart into the installed version. The response that asked for it is
   * answered first: the restart is scheduled, not performed inline.
   *
   * Not `async`: nothing here is awaited (the delay hands the work to
   * #performRestart), but the signature stays promise-shaped so callers can
   * treat every update action the same way.
   */
  restart(): Promise<UpdateStatus> {
    if (!this.#status.supported || this.#status.restarting) {
      return Promise.resolve(this.status());
    }
    if (this.#restartMode === "none") {
      this.#fail(
        "このサーバーは自動再起動が無効です (LUMISCA_UPDATE_RESTART=none)。" +
          "次回の起動で新しいバージョンが有効になります。",
      );
      return Promise.resolve(this.status());
    }
    if (!this.#status.restartPending) {
      this.#fail("再起動して有効になる更新がありません");
      return Promise.resolve(this.status());
    }
    this.#patch({ restarting: true, error: null });
    setTimeout(
      () => void this.#performRestart(),
      this.#options.restartDelayMs ?? RESTART_DELAY_MS,
    );
    return Promise.resolve(this.status());
  }

  async #performRestart(): Promise<void> {
    try {
      await this.#options.shutdown?.();
      (this.#options.spawnSuccessor ?? startSuccessor)({
        execPath: this.#environment.execPath,
        cwd: this.#options.cwd,
        env: successorEnvironment(
          this.#options.startupEnv,
          this.#options.successorPortWaitMs ?? SUCCESSOR_PORT_WAIT_MS,
        ),
      });
      // The successor owns the port from here on; this process is done.
      (this.#options.exit ?? Deno.exit)(0);
    } catch (error) {
      this.#patch({ restarting: false });
      this.#fail(`再起動に失敗しました: ${errorMessage(error)}`);
      // The shutdown is not reversible: the listener (and, past core.close(),
      // the database) are already released, so this process can never serve
      // again — and the UI cannot be told, because nothing is listening. A
      // process left in that state is unreachable but still alive (the
      // periodic timer keeps it running, and the desktop shell deliberately
      // does not kill a live-but-silent server), which would leave the user
      // with a dead port and no explanation. Exit non-zero instead, so
      // whatever supervises this server can start it again.
      console.error(
        `Lumisca: 再起動に失敗しました: ${errorMessage(error)}` +
          " (このプロセスは終了します)",
      );
      (this.#options.exit ?? Deno.exit)(1);
    }
  }

  #patch(patch: Partial<UpdateStatus>): void {
    this.#status = { ...this.#status, ...patch };
  }

  #fail(message: string): void {
    this.#patch({
      checking: false,
      downloading: false,
      restarting: false,
      error: message,
    });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
