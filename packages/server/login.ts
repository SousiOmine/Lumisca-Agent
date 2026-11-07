import { randomUUID } from "node:crypto";
import type { AuthInteraction, AuthNotice, AuthPrompt } from "@lumisca/core";
import { errorMessage } from "@lumisca/core";
import type {
  ProviderLoginEvent,
  ProviderLoginPrompt,
  ProviderLoginSnapshot,
} from "@lumisca/core";

/** A finished login session is kept briefly so the client can poll the
 * final state; a session that never settles (stuck flow) is swept after
 * the idle budget. */
const DONE_RETENTION_MS = 60_000;
const IDLE_TIMEOUT_MS = 15 * 60_000;

/**
 * One in-flight provider login, bridging the core's `AuthInteraction` and
 * the settings UI.
 *
 * The flow runs server-side (started from the POST /login handler, not
 * awaited). `notify` events (device code, auth URL, info, progress) are
 * appended to a log the client polls; `prompt` calls are queued as the
 * current pending prompt until the client responds via
 * POST /login/:sessionId/respond.
 *
 * The method is the client's choice, carried through to the flow as
 * `AuthInteraction.method`. The bridge never answers a prompt on the
 * user's behalf: a flow that offers a choice must show it.
 */
export class LoginSession {
  readonly sessionId: string = randomUUID();
  readonly providerId: string;
  private readonly method: "browser" | "device_code";

  private status: ProviderLoginSnapshot["status"] = "starting";
  private readonly events: ProviderLoginEvent[] = [];
  private error: string | undefined;
  private settled = false;

  private readonly abort = new AbortController();
  private promptSeq = 0;
  private readonly awaiting: Array<{
    id: string;
    prompt: AuthPrompt;
    resolve: (value: string) => void;
    reject: (reason: unknown) => void;
  }> = [];

  private idleTimer: ReturnType<typeof setTimeout>;
  private retentionTimer: ReturnType<typeof setTimeout> | undefined;
  private doneHandled = false;

  constructor(
    providerId: string,
    method: "browser" | "device_code",
    startLogin: (interaction: AuthInteraction) => Promise<void>,
    private readonly onExpire: (sessionId: string) => void,
  ) {
    this.providerId = providerId;
    this.method = method;
    this.idleTimer = setTimeout(
      () => this.expire(),
      IDLE_TIMEOUT_MS,
    );
    void this.begin(startLogin);
  }

  /** The state the client polls. `events` is the full log; the client
   * renders entries beyond the last one it has seen. */
  snapshot(): ProviderLoginSnapshot {
    return {
      sessionId: this.sessionId,
      providerId: this.providerId,
      status: this.status,
      events: [...this.events],
      prompt: this.awaiting.length > 0
        ? {
          id: this.awaiting[0]!.id,
          ...this.pendingPrompt(this.awaiting[0]!.prompt),
        }
        : undefined,
      error: this.error,
    };
  }

  /** Resolve a prompt the client answered. False when the prompt id no
   * longer matches (already answered / cancelled). */
  respond(promptId: string, value: string): boolean {
    const index = this.awaiting.findIndex((a) => a.id === promptId);
    if (index === -1) return false;
    const [entry] = this.awaiting.splice(index, 1);
    entry!.resolve(value);
    return true;
  }

  /** Abort the flow (rejects any pending prompt; the run loop settles the
   * session as "cancelled"). */
  cancel(): void {
    if (this.settled) return;
    this.rejectAwaiting(new Error("Login cancelled"));
    this.abort.abort();
  }

  /** True once, for the route to invalidate the auth cache when the flow
   * has actually persisted a credential. */
  consumeDone(): boolean {
    if (this.status !== "done" || this.doneHandled) return false;
    this.doneHandled = true;
    return true;
  }

  /** True while the flow is still running (not yet done/error/cancelled).
   * The login route reuses an active session per provider so repeated
   * clicks cannot stack concurrent polls at the provider's auth server. */
  isActive(): boolean {
    return !this.settled;
  }

  /** Clear timers and pending prompts; used when the session is dropped
   * early (cancel / shutdown). */
  dispose(): void {
    clearTimeout(this.idleTimer);
    if (this.retentionTimer !== undefined) clearTimeout(this.retentionTimer);
    this.rejectAwaiting(new Error("Login session closed"));
    this.abort.abort();
  }

  private async begin(
    startLogin: (interaction: AuthInteraction) => Promise<void>,
  ): Promise<void> {
    const interaction: AuthInteraction = {
      signal: this.abort.signal,
      method: this.method,
      prompt: (prompt) => this.prompt(prompt),
      notify: (event) => this.notify(event),
    };
    try {
      await startLogin(interaction);
      this.finish("done");
    } catch (error) {
      if (this.abort.signal.aborted) {
        this.finish("cancelled");
      } else {
        this.finish("error", friendlyLoginError(errorMessage(error)));
      }
    }
  }

  private finish(
    status: "done" | "error" | "cancelled",
    message?: string,
  ): void {
    if (this.settled) return;
    this.settled = true;
    this.status = status;
    this.error = message;
    clearTimeout(this.idleTimer);
    // Keep the final state around briefly so the client can poll it.
    this.retentionTimer = setTimeout(
      () => this.expire(),
      DONE_RETENTION_MS,
    );
  }

  private expire(): void {
    this.dispose();
    this.onExpire(this.sessionId);
  }

  private notify(event: AuthNotice): void {
    if (this.settled) return;
    // The core's AuthEvent and the frontend-safe ProviderLoginEvent have
    // identical shapes (minus nothing), so a pass-through cast suffices.
    this.events.push(event as ProviderLoginEvent);
  }

  private prompt(prompt: AuthPrompt): Promise<string> {
    const id = `p${++this.promptSeq}`;
    return new Promise<string>((resolve, reject) => {
      this.awaiting.push({ id, prompt, resolve, reject });
    });
  }

  private pendingPrompt(prompt: AuthPrompt): ProviderLoginPrompt {
    // Structural subset of AuthPrompt (signal stripped) — safe cast.
    return prompt as ProviderLoginPrompt;
  }

  private rejectAwaiting(reason: unknown): void {
    for (const entry of this.awaiting.splice(0)) {
      entry.reject(reason);
    }
  }
}

/** Signatures of OpenAI-side throttling / bot detection (a 429 status, a
 * Cloudflare "Just a moment..." challenge, or an explicit rate limit) —
 * not a Lumisca or credential problem the user can fix by re-entering
 * anything. */
const RATE_LIMIT_RE =
  /status 429|just a moment|cloudflare|__cf_chl|rate\s?limit|too many requests|challenge/i;

/** Friendlier wording for OpenAI-side throttling so the user knows to wait
 * and retry instead of assuming the login is broken. Other errors pass
 * through unchanged. */
export function friendlyLoginError(message: string): string {
  if (RATE_LIMIT_RE.test(message)) {
    return "認証元の利用制限（レートリミット）またはアクセス検証により、ログインできませんでした。時間をおいて再度お試しください。";
  }
  return message;
}

/** Registry of live login sessions keyed by session id. Sessions remove
 * themselves shortly after settling. */
export class LoginSessions {
  private readonly sessions = new Map<string, LoginSession>();

  create(
    providerId: string,
    method: "browser" | "device_code",
    startLogin: (interaction: AuthInteraction) => Promise<void>,
  ): LoginSession {
    const session = new LoginSession(
      providerId,
      method,
      startLogin,
      (id) => this.sessions.delete(id),
    );
    this.sessions.set(session.sessionId, session);
    return session;
  }

  get(sessionId: string): LoginSession | undefined {
    return this.sessions.get(sessionId);
  }

  /** An active (still running) session for a provider, if any — the login
   * route reuses it instead of starting a second concurrent flow. */
  getActive(providerId: string): LoginSession | undefined {
    for (const session of this.sessions.values()) {
      if (session.providerId === providerId && session.isActive()) {
        return session;
      }
    }
    return undefined;
  }
}
