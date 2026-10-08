/**
 * Interactive MCP sign-in sessions.
 *
 * One session drives one HTTP server's OAuth flow: it starts a connection
 * (which walks discovery, registration and the authorization request), hands
 * the authorization URL to the UI, and — when the browser comes back with a
 * code — exchanges it for tokens. Afterwards the stored grant is what every
 * later connection uses, so the session only covers the interactive part.
 *
 * A sign-in session lives in memory on purpose: it exists while a user is
 * being sent to a browser, and a server restart during that means starting
 * over — not leaving a half-finished flow that nothing can complete.
 */
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { errorMessage } from "../errors.ts";
import { createMcpTransport } from "./client.ts";
import type { McpServerConfig } from "./config.ts";
import { McpOAuthProvider, type McpOAuthStore } from "./oauth.ts";

/** Where a sign-in is in its life: `starting` while the connection that
 * produces the authorization URL runs, `waiting` while the user is in the
 * browser, then one of the settled states. */
export type McpAuthStatus =
  | "starting"
  | "waiting"
  | "done"
  | "error"
  | "cancelled";

/** What the UI polls (and what the callback answers with). */
export interface McpAuthSnapshot {
  sessionId: string;
  serverUrl: string;
  status: McpAuthStatus;
  /** Where to send the user; present once the status is `waiting`. */
  authorizationUrl?: string;
  error?: string;
}

/** Bound on the handshake that *starts* the flow (discovery, dynamic
 * registration, authorization request) — not on the time the user may take
 * in the browser, which IDLE_TIMEOUT_MS bounds. */
const START_TIMEOUT_MS = 30_000;

/** How long a sign-in waits for the browser before it is forgotten. */
const IDLE_TIMEOUT_MS = 10 * 60_000;

/** How long a settled session is kept, so a polling client still sees how
 * it ended. */
const DONE_RETENTION_MS = 60_000;

/** One server's sign-in. */
export class McpAuthSession {
  readonly sessionId: string = randomUUID();
  /** OAuth `state` of this flow: the callback carries it back, and it is
   * what ties the returning browser to this session. */
  private readonly state = randomUUID();

  private status: McpAuthStatus = "starting";
  private authorizationUrl?: string;
  private error?: string;

  private readonly client = new Client({ name: "lumisca", version: "0.1" });
  private transport?: StreamableHTTPClientTransport;

  /** Resolves when the session leaves `starting`, so the API route can
   * answer with the authorization URL instead of an empty snapshot. */
  private readonly ready: Promise<void>;
  private markReady!: () => void;

  private readonly idleTimer: ReturnType<typeof setTimeout>;
  private retentionTimer?: ReturnType<typeof setTimeout>;

  constructor(
    readonly serverUrl: string,
    private readonly config: McpServerConfig,
    private readonly store: McpOAuthStore,
    private readonly redirectUri: string,
    private readonly onExpire: (sessionId: string) => void,
  ) {
    this.ready = new Promise((resolve) => {
      this.markReady = resolve;
    });
    this.idleTimer = setTimeout(() => this.expire(), IDLE_TIMEOUT_MS);
    void this.begin();
  }

  snapshot(): McpAuthSnapshot {
    return {
      sessionId: this.sessionId,
      serverUrl: this.serverUrl,
      status: this.status,
      ...(this.authorizationUrl !== undefined
        ? { authorizationUrl: this.authorizationUrl }
        : {}),
      ...(this.error !== undefined ? { error: this.error } : {}),
    };
  }

  /** The snapshot once the flow either waits for the browser or has failed
   * to start. The client gets the authorization URL in hand this way, so it
   * can open the browser straight from the click that started it (a
   * popup blocked later would have to be allowed by hand). */
  async started(): Promise<McpAuthSnapshot> {
    await this.ready;
    return this.snapshot();
  }

  /** Whether this is the sign-in the callback's `state` belongs to. */
  matchesState(state: string): boolean {
    return this.status === "waiting" && state === this.state;
  }

  /** Exchange the authorization code the browser brought back. */
  async complete(code: string): Promise<void> {
    const transport = this.transport;
    if (this.status !== "waiting" || transport === undefined) {
      throw new Error(
        `MCP sign-in is not waiting for an authorization (${this.status})`,
      );
    }
    try {
      await transport.finishAuth(code);
      this.settle("done");
    } catch (error) {
      this.settle("error", errorMessage(error));
    } finally {
      await this.close();
    }
  }

  /** Record the authorization server's refusal (the callback can carry an
   * `error` instead of a code). */
  fail(message: string): void {
    if (this.status === "waiting") this.settle("error", message);
  }

  /** Give up on this sign-in (user cancelled, server shutting down). */
  cancel(): void {
    this.settle("cancelled");
    void this.close();
  }

  private async begin(): Promise<void> {
    const provider = new McpOAuthProvider({
      store: this.store,
      serverUrl: this.serverUrl,
      interactive: true,
      redirectUri: this.redirectUri,
      state: this.state,
    });
    const transport = createMcpTransport(this.config, Deno.cwd(), {
      authProvider: provider,
    });
    this.transport = transport;
    try {
      await this.client.connect(transport, { timeout: START_TIMEOUT_MS });
      // The stored grant still works: the connection was established
      // without a new authorization, so there is nothing to sign in to.
      this.settle("done");
    } catch (error) {
      const authorizationUrl = provider.authorizationUrl;
      if (authorizationUrl === undefined) {
        // Discovery, registration or the authorization request itself
        // failed — the flow never reached the user.
        this.settle("error", errorMessage(error));
        return;
      }
      this.authorizationUrl = authorizationUrl.toString();
      this.status = "waiting";
      this.markReady();
    }
  }

  private settle(
    status: "done" | "error" | "cancelled",
    error?: string,
  ): void {
    if (this.status !== "starting" && this.status !== "waiting") return;
    this.status = status;
    this.error = error;
    clearTimeout(this.idleTimer);
    this.markReady();
    this.retentionTimer = setTimeout(() => this.expire(), DONE_RETENTION_MS);
  }

  private expire(): void {
    clearTimeout(this.idleTimer);
    if (this.retentionTimer !== undefined) clearTimeout(this.retentionTimer);
    this.onExpire(this.sessionId);
    void this.close();
  }

  /** Drop the client and its transport; both are single-use (the tokens of
   * a completed sign-in live in the store, not on this connection). */
  private async close(): Promise<void> {
    try {
      await this.client.close();
    } catch {
      // the server may already be gone
    }
  }
}

/** The sign-ins of one server process, keyed by session id. */
export class McpAuthSessions {
  private readonly sessions = new Map<string, McpAuthSession>();

  /** Start a sign-in for one server; it runs in the background, and
   * `session.started()` answers once it waits for the browser. */
  create(
    config: McpServerConfig,
    store: McpOAuthStore,
    redirectUri: string,
  ): McpAuthSession {
    const session = new McpAuthSession(
      config.url!,
      config,
      store,
      redirectUri,
      (id) => this.sessions.delete(id),
    );
    this.sessions.set(session.sessionId, session);
    return session;
  }

  get(sessionId: string): McpAuthSession | undefined {
    return this.sessions.get(sessionId);
  }

  /** The sign-in waiting on the callback's `state`, if any. */
  getByState(state: string): McpAuthSession | undefined {
    for (const session of this.sessions.values()) {
      if (session.matchesState(state)) return session;
    }
    return undefined;
  }

  /** Cancel everything (server shutdown). */
  close(): void {
    for (const session of [...this.sessions.values()]) session.cancel();
    this.sessions.clear();
  }
}
