import type { SessionPool } from "../agent/pool.ts";
import type { BrowserBackend } from "../browser/types.ts";
import type { ComputerHost, ComputerHostResult } from "../computer/types.ts";
import {
  APP_UI_IN_SYSTEM_PROMPT_KEY,
  ASK_TOOL_ENABLED_KEY,
  appUiInSystemPrompt,
  askToolEnabled,
  CODE_EXECUTION_ENABLED_KEY,
  codeExecutionEnabled,
} from "../shared/mod.ts";
import type { ComputerUseService } from "./computer.ts";
import type { SessionService } from "./sessions.ts";
import type { SettingsService } from "./settings.ts";

export interface CapabilitiesDeps {
  computer: ComputerUseService;
  settings: SettingsService;
  sessions: SessionService;
  pool: SessionPool;
}

/**
 * What this installation lets an agent do: drive the screen, run programs,
 * ask questions, and carry the app-card guide in its prompt. Each switch
 * changes the tools or the prompt an agent is built with, so a change also
 * tells every open session to rebuild — an idle one now, a running one when
 * its run ends.
 */
export class Capabilities {
  readonly #deps: CapabilitiesDeps;
  #browserBackend: BrowserBackend | undefined;

  constructor(deps: CapabilitiesDeps) {
    this.#deps = deps;
  }

  /** Attach (or detach, with undefined) the browser-lab backend. */
  setBrowserBackend(backend: BrowserBackend | undefined): void {
    this.#browserBackend = backend;
  }

  getBrowserBackend(): BrowserBackend | undefined {
    return this.#browserBackend;
  }

  setComputerHost(result: ComputerHostResult): void {
    this.#deps.computer.setHost(result);
  }

  setComputerHostProbe(probe: () => Promise<ComputerHostResult>): void {
    this.#deps.computer.setProbe(probe);
  }

  recheckComputerHost(): Promise<ComputerHostResult> {
    return this.#deps.computer.recheck();
  }

  getComputerHost(): ComputerHost | undefined {
    return this.#deps.computer.getHost();
  }

  isComputerUseEnabled(): boolean {
    return this.#deps.computer.isEnabled();
  }

  setComputerUseEnabled(enabled: boolean): Promise<void> {
    return this.#deps.computer.setEnabled(enabled);
  }

  /** The host a session may drive (attached AND enabled). */
  computerHostForSession(): ComputerHost | undefined {
    return this.#deps.computer.hostForSession();
  }

  isCodeExecutionEnabled(): boolean {
    return codeExecutionEnabled((key) => this.#deps.settings.get(key));
  }

  setCodeExecutionEnabled(enabled: boolean): void {
    this.#deps.pool.applyChange(
      this.#deps.sessions.listEverySession(),
      () =>
        this.#deps.settings.set(CODE_EXECUTION_ENABLED_KEY, enabled ? "1" : ""),
      "defer",
      { defer: (id) => this.#deps.sessions.deferRebuild(id) },
    );
  }

  isAskToolEnabled(): boolean {
    return askToolEnabled((key) => this.#deps.settings.get(key));
  }

  setAskToolEnabled(enabled: boolean): void {
    this.#deps.pool.applyChange(
      this.#deps.sessions.listEverySession(),
      () => this.#deps.settings.set(ASK_TOOL_ENABLED_KEY, enabled ? "1" : "0"),
      "defer",
      { defer: (id) => this.#deps.sessions.deferRebuild(id) },
    );
  }

  isAppUiInSystemPrompt(): boolean {
    return appUiInSystemPrompt((key) => this.#deps.settings.get(key));
  }

  setAppUiInSystemPrompt(enabled: boolean): void {
    this.#deps.pool.applyChange(
      this.#deps.sessions.listEverySession(),
      () =>
        this.#deps.settings.set(
          APP_UI_IN_SYSTEM_PROMPT_KEY,
          enabled ? "1" : "",
        ),
      "defer",
      { defer: (id) => this.#deps.sessions.deferRebuild(id) },
    );
  }
}
