import type { McpServerConfig } from "../shared/mcp-config.ts";
import type { McpConfig } from "./config.ts";
import { McpManager } from "./manager.ts";
import type { McpOAuthStore } from "./oauth.ts";
import { McpAuthSessions, type McpAuthSnapshot } from "./oauth-session.ts";

/**
 * The connections this service owns itself, as opposed to the ones a session
 * owns (the pool closes those with their sessions): the OAuth grants and
 * interactive sign-ins of the HTTP servers, and the manager a `watch` check
 * calls through.
 */
export class McpConnections {
  /** Interactive sign-ins still waiting on a browser. */
  private readonly authSessions = new McpAuthSessions();
  /** The connections a `watch` check calls through, and the config text they
   * were built from. Separate from any session's manager: a check runs
   * whether or not a client has the conversation open, and a headless server
   * has no session at all. */
  private checkManager: McpManager | null = null;
  private checkManagerKey: string | null = null;

  constructor(
    /** Where OAuth grants are kept, shared with the session connections and
     * the probes (see mcp/oauth.ts). */
    private readonly oauth: McpOAuthStore,
    /** The app-level config: the only one a check can see, because a routine
     * has no workspace and a plugin's servers come and go with the plugin. */
    private readonly appConfig: () => McpConfig,
  ) {}

  /** Start an interactive OAuth sign-in for one HTTP server. The flow runs
   * in the background; the resolved snapshot carries the authorization URL
   * the UI opens (or the reason the flow could not start). */
  async startAuth(
    server: McpServerConfig,
    redirectUri: string,
  ): Promise<McpAuthSnapshot> {
    return await this.authSessions
      .create(server, this.oauth, redirectUri)
      .started();
  }

  /** The current state of one sign-in, or undefined once it is forgotten. */
  getAuth(sessionId: string): McpAuthSnapshot | undefined {
    return this.authSessions.get(sessionId)?.snapshot();
  }

  /** Give up on a sign-in (the user cancelled it). */
  cancelAuth(sessionId: string): boolean {
    const session = this.authSessions.get(sessionId);
    if (session === undefined) return false;
    session.cancel();
    return true;
  }

  /**
   * Finish the sign-in the browser came back to: `state` names the flow,
   * and either `code` (to exchange for tokens) or `error` (the
   * authorization server's refusal) says how it went. Undefined when no
   * sign-in waits on that state — an expired, cancelled or forged callback.
   * A `done` snapshot is the caller's cue to reconnect the sessions that use
   * the server: the grant it stored changes no config, so nothing else would
   * pick it up.
   */
  async completeAuth(input: {
    state: string;
    code?: string;
    error?: string;
  }): Promise<McpAuthSnapshot | undefined> {
    const session = this.authSessions.getByState(input.state);
    if (session === undefined) return undefined;
    if (input.error !== undefined) {
      session.fail(`authorization failed: ${input.error}`);
    } else if (input.code !== undefined) {
      await session.complete(input.code);
    } else {
      session.fail(
        "the authorization response carried neither a code nor an error",
      );
    }
    return session.snapshot();
  }

  /** The manager the checks call through, built from the app-level config.
   * Rebuilt when the config changed, so a check never calls a server the
   * user just removed. */
  managerForChecks(): McpManager {
    const config = this.appConfig();
    const key = JSON.stringify(config.servers);
    const existing = this.checkManager;
    if (existing !== null && this.checkManagerKey === key) return existing;
    this.dropCheckManager();
    const manager = new McpManager(config, process.cwd(), this.oauth);
    this.checkManager = manager;
    this.checkManagerKey = key;
    return manager;
  }

  /** Close the checks' connections, so the next check builds them from the
   * config as it stands now. */
  dropCheckManager(): void {
    const manager = this.checkManager;
    this.checkManager = null;
    this.checkManagerKey = null;
    if (manager !== null) void manager.close();
  }

  /** Close whatever this service owns (the sessions' managers belong to the
   * pool, which closes them with their sessions). */
  close(): void {
    this.dropCheckManager();
  }
}
