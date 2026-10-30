/** Frontend-safe shared helpers (see shared/mod.ts): pure functions and constants with no runtime dependencies (no db / transport imports), bundled into the browser client. */

/** Minimal usage shape for context accounting: the app's own `Usage` (see
 * ai/types.ts). `input` counts the prompt tokens the provider did *not*
 * serve from its prompt cache; the cached parts are reported separately, so
 * one turn's prompt — what occupies the context window — is
 * `input + cacheRead + cacheWrite`. This interface keeps the shared module
 * dependency-free so the web bundle and the server share one
 * implementation. */
export interface ContextUsageLike {
  /** Uncached prompt tokens. */
  input?: number | null;
  /** Prompt tokens served from the prompt cache. */
  cacheRead?: number | null;
  /** Prompt tokens written into the prompt cache. */
  cacheWrite?: number | null;
}

/** Minimal message shape for context accounting (only the fields the
 * summary reads). */
export interface ContextUsageMessageLike {
  role: string;
  usage?: ContextUsageLike | null;
}

/** Session-level context summary derived from assistant `usage` rows:
 * `currentTokens` is the prompt the latest turn sent, while the
 * totals/average span the whole session. */
export interface ContextUsageSummary {
  /** Assistant turns that reported tokens. */
  turns: number;
  /** Latest turn's prompt tokens (input + cacheRead + cacheWrite). */
  currentTokens?: number;
  /** Latest turn's cache-read tokens. */
  currentCacheRead: number;
  /** Sum of prompt tokens over every turn with usage. */
  totalTokens: number;
  /** Sum of cache-read tokens over every turn with usage. */
  totalCacheRead: number;
  /** totalCacheRead / totalTokens (undefined when nothing was counted). */
  averageCacheHitRate?: number;
}

function usageNumber(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

/** Prompt tokens of one turn: uncached input + cache reads + cache writes.
 * All three count against the model's context window, and providers that
 * report the split (DeepSeek, Anthropic, ...) never fold the cached parts
 * into `input` — summing them is what makes the meter match the prompt the
 * model actually received. */
export function contextTokensOf(usage?: ContextUsageLike | null): number {
  if (!usage) return 0;
  return usageNumber(usage.input) + usageNumber(usage.cacheRead) +
    usageNumber(usage.cacheWrite);
}

/** Summarize context usage over a transcript. Only `role === "assistant"`
 * messages that reported tokens contribute; anything else (user/tool-result
 * rows, messages without usage, and failure placeholders whose usage is all
 * zeros) is ignored. */
export function summarizeContextUsage(
  messages: readonly ContextUsageMessageLike[],
): ContextUsageSummary {
  let turns = 0;
  let currentTokens: number | undefined;
  let currentCacheRead = 0;
  let totalTokens = 0;
  let totalCacheRead = 0;
  for (const message of messages) {
    // A turn reports no tokens only when there was nothing to report (the
    // placeholder an aborted/failed call leaves behind): it carries no
    // context, and counting it would reset the meter to 0.
    const contribution = contextUsageOfMessage(message);
    if (contribution === undefined) continue;
    turns++;
    currentTokens = contribution.tokens;
    currentCacheRead = contribution.cacheRead;
    totalTokens += contribution.tokens;
    totalCacheRead += contribution.cacheRead;
  }
  return {
    turns,
    ...(currentTokens === undefined ? {} : { currentTokens }),
    currentCacheRead,
    totalTokens,
    totalCacheRead,
    ...(totalTokens > 0
      ? { averageCacheHitRate: totalCacheRead / totalTokens }
      : {}),
  };
}

/** The prompt budget of one model: its context window, narrowed to the
 * input cap the catalog publishes (`limit.input`). The window counts the
 * completion as well, so a provider that documents both numbers rejects a
 * prompt past the input cap (models.dev publishes 922,000 against a
 * 1,050,000 window for OpenAI's largest models, for example). Compaction,
 * the output clamp and the context meter all measure against this budget;
 * a model that publishes no cap keeps its window. Undefined when neither
 * number is usable, which leaves compaction off. */
export function inputBudgetTokens(
  model: { contextWindow?: number; maxInputTokens?: number },
): number | undefined {
  const usable = [model.contextWindow, model.maxInputTokens].filter(
    (value): value is number =>
      typeof value === "number" && Number.isFinite(value) && value > 0,
  );
  return usable.length > 0 ? Math.min(...usable) : undefined;
}

/** Ratio of the latest turn's context against the budget (undefined when
 * either side is missing). Values above 1 mean the transcript already
 * exceeds the budget. */
export function contextUsageRatio(
  summary: ContextUsageSummary,
  contextWindow?: number,
): number | undefined {
  if (
    summary.currentTokens === undefined || contextWindow === undefined ||
    !Number.isFinite(contextWindow) || contextWindow <= 0
  ) {
    return undefined;
  }
  return summary.currentTokens / contextWindow;
}

/** The usage ratio at which the next compaction check condenses the history:
 * `(contextWindow - reserveTokens) / contextWindow` (see
 * agent/context-compaction.ts). The context meter warns from here on, so the
 * amber bar and the checkpoint that follows describe the same moment.
 * Undefined when the window is unknown or the reservation leaves no room —
 * compaction is then off, and the meter keeps its own default hint. */
export function compactionUsageRatio(
  contextWindow: number | undefined,
  reserveTokens: number,
): number | undefined {
  if (
    contextWindow === undefined || !Number.isFinite(contextWindow) ||
    contextWindow <= 0 || !Number.isFinite(reserveTokens) || reserveTokens <= 0
  ) {
    return undefined;
  }
  const threshold = contextWindow - reserveTokens;
  if (threshold <= 0) return undefined;
  return Math.min(1, threshold / contextWindow);
}

/** Compact token count matching the reference card: 999 → "999",
 * 301200 → "301.2K", 1000000 → "1M", 1500000 → "1.5M". */
export function formatCompactTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value >= 1_000_000) {
    const m = value / 1_000_000;
    const text = m >= 100
      ? String(Math.round(m))
      : String(Math.round(m * 100) / 100);
    return `${text}M`;
  }
  if (value >= 1000) {
    const k = value / 1000;
    const rounded = Math.round(k * 10) / 10;
    return `${
      Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)
    }K`;
  }
  return String(Math.round(value));
}

/** Ratio as a one-decimal percent: 0.924 → "92.4%". */
export function formatPercent1(ratio: number): string {
  if (!Number.isFinite(ratio)) return "—";
  return `${(ratio * 100).toFixed(1)}%`;
}

/** One-line rendering: "301.2K/1M (30.1%) · Avg cache hit 92.4%".
 * Segments without data are omitted ("301.2K" alone when the window is
 * unknown, "" when the session has no usage yet). */
export function formatContextUsageLine(
  summary: ContextUsageSummary,
  contextWindow?: number,
): string {
  if (summary.currentTokens === undefined) return "";
  const used = formatCompactTokens(summary.currentTokens);
  const ratio = contextUsageRatio(summary, contextWindow);
  const head = contextWindow && contextWindow > 0
    ? `${used}/${formatCompactTokens(contextWindow)}${
      ratio === undefined ? "" : ` (${formatPercent1(ratio)})`
    }`
    : used;
  return summary.averageCacheHitRate === undefined
    ? head
    : `${head} · Avg cache hit ${formatPercent1(summary.averageCacheHitRate)}`;
}

/** The tokens and cache reads one assistant message contributes to a
 * summary; undefined for a message that contributes nothing (another role,
 * no usage, or the zero-usage placeholder a failed/aborted call leaves
 * behind — counting it would reset the meter to 0). */
export function contextUsageOfMessage(
  message: ContextUsageMessageLike,
): { tokens: number; cacheRead: number } | undefined {
  if (message.role !== "assistant" || !message.usage) return undefined;
  const tokens = contextTokensOf(message.usage);
  if (tokens === 0) return undefined;
  return { tokens, cacheRead: usageNumber(message.usage.cacheRead) };
}

/**
 * Fold the contribution of one more assistant message into a summary.
 *
 * The web client draws a WINDOW of a session's transcript (see the core's
 * session/transcript-window.ts), so it cannot summarize the whole history
 * itself: a meter computed from the window would report the window's average
 * as the session's and lose its totals as soon as the reader paged back. The
 * server summarizes the whole transcript once per snapshot, and this is how
 * the client keeps that summary current as messages stream in without
 * re-reading it.
 */
export function addContextUsage(
  summary: ContextUsageSummary,
  message: ContextUsageMessageLike,
): ContextUsageSummary {
  const contribution = contextUsageOfMessage(message);
  if (contribution === undefined) return summary;
  const totalTokens = summary.totalTokens + contribution.tokens;
  const totalCacheRead = summary.totalCacheRead + contribution.cacheRead;
  return {
    turns: summary.turns + 1,
    // The newest counted turn is the prompt the latest request sent.
    currentTokens: contribution.tokens,
    currentCacheRead: contribution.cacheRead,
    totalTokens,
    totalCacheRead,
    ...(totalTokens > 0
      ? { averageCacheHitRate: totalCacheRead / totalTokens }
      : {}),
  };
}

/**
 * Drop one assistant message's contribution from a summary (a rewind removed
 * it from the transcript). Totals only: which turn `currentTokens` should
 * describe afterwards is decided against the messages that remain (see
 * withLatestContextUsage), because a summary cannot know what came before the
 * removed one.
 */
export function subtractContextUsage(
  summary: ContextUsageSummary,
  message: ContextUsageMessageLike,
): ContextUsageSummary {
  const contribution = contextUsageOfMessage(message);
  if (contribution === undefined) return summary;
  const totalTokens = Math.max(0, summary.totalTokens - contribution.tokens);
  const totalCacheRead = Math.max(
    0,
    summary.totalCacheRead - contribution.cacheRead,
  );
  return {
    turns: Math.max(0, summary.turns - 1),
    currentTokens: summary.currentTokens,
    currentCacheRead: summary.currentCacheRead,
    totalTokens,
    totalCacheRead,
    ...(totalTokens > 0
      ? { averageCacheHitRate: totalCacheRead / totalTokens }
      : {}),
  };
}

/**
 * Point the summary's "current" side at the newest assistant turn among
 * `messages` (the loaded window's tail: a view always holds the transcript's
 * end, so this is the latest turn the server priced). A window with no priced
 * turn keeps the summary's current values (the counted totals still describe
 * the session, and the meter must not blink to zero).
 */
export function withLatestContextUsage(
  summary: ContextUsageSummary,
  messages: readonly ContextUsageMessageLike[],
): ContextUsageSummary {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    const contribution = contextUsageOfMessage(message);
    if (contribution === undefined) continue;
    return {
      ...summary,
      currentTokens: contribution.tokens,
      currentCacheRead: contribution.cacheRead,
    };
  }
  return summary;
}
