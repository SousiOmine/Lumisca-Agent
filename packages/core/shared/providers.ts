/** Frontend-safe shared helpers (see shared/mod.ts): pure functions and constants with no runtime dependencies (no db / pi imports), bundled into the browser client. */

/**
 * Reasoning-effort levels for a model. "off" disables thinking; the rest
 * match pi-ai's ThinkingLevel so values pass straight into the agent.
 */
export type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

/** User-facing labels for the thinking levels. Shared by the web UI and
 * the CLI so the level names stay consistent. */
export const THINKING_LEVEL_LABELS: Record<ThinkingLevel, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

/** Thinking levels weakest-first ("off" first). Single source of truth for
 * the strength order; the web slider sorts supported levels with this, and
 * `models/thinking.ts` derives `ALL_THINKING_LEVELS` from it. */
export const THINKING_LEVEL_ORDER: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** Provider summary for pickers and lists. Shared by the server routes
 * (which build these) and the web UI (which renders them). */
export interface ProviderInfo {
  id: string;
  name: string;
  configured?: boolean;
  source?: string;
  /** The credential method the provider accepts. "oauth" providers get a
   * login flow in the settings UI instead of an API-key field. */
  authType?: ProviderAuthType;
  /** True when the provider was added by the user (OpenAI-compatible
   * custom provider) rather than built in or from env/models.json config. */
  userDefined?: boolean;
}

/** Credential method of a provider ("api_key" for API-key entry, "oauth"
 * for the subscription/login flow). Shared with the settings UI so it can
 * choose the right control. */
export type ProviderAuthType = "api_key" | "oauth";

/** One event a login flow notifies the UI about (device code, auth URL,
 * info, progress). Mirrors the minimal shape the web client needs to drive
 * the user through the OAuth flow; independent of the pi-ai's own event
 * type so the frontend stays pi-free. */
export type ProviderLoginEvent =
  | {
    type: "info";
    message: string;
    links?: { url: string; label?: string }[];
  }
  | { type: "auth_url"; url: string; instructions?: string }
  | {
    type: "device_code";
    userCode: string;
    verificationUri: string;
    intervalSeconds?: number;
    expiresInSeconds?: number;
  }
  | { type: "progress"; message: string };

/** A prompt a login flow needs the user to answer; the UI renders the
 * matching input and posts the value back. */
export type ProviderLoginPrompt =
  | { type: "text"; message: string; placeholder?: string }
  | { type: "secret"; message: string; placeholder?: string }
  | {
    type: "select";
    message: string;
    options: { id: string; label: string; description?: string }[];
  }
  | { type: "manual_code"; message: string; placeholder?: string };

/** Polled snapshot of one in-flight login session (the server runs the
 * flow; the client polls until "done" / "error" / "cancelled"). */
export interface ProviderLoginSnapshot {
  sessionId: string;
  providerId: string;
  status: "starting" | "waiting" | "done" | "error" | "cancelled";
  /** Events in arrival order; the client renders new ones past the last
   * one it has seen. */
  events: ProviderLoginEvent[];
  /** The prompt awaiting an answer, if any. `id` is what the client posts
   * back to respond. */
  prompt?: ProviderLoginPrompt & { id: string };
  error?: string;
}

/** Model summary with enablement info, for pickers and the settings UI. */
export interface ModelInfo {
  id: string;
  name: string;
  contextWindow?: number;
  reasoning?: boolean;
  input?: string[];
  enabled?: boolean;
  /** Stored thinking level for this model ("off" when unset). */
  thinkingLevel?: ThinkingLevel;
  /** The thinking levels this model actually supports (at least ["off"]). */
  thinkingLevels?: ThinkingLevel[];
}
