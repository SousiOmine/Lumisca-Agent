/** Frontend-safe shared helpers (see shared/mod.ts): pure functions and constants with no runtime dependencies (no db / pi imports), bundled into the browser client. */

/** Minimal usage shape for context accounting. The Vercel-backed
 * transport emits the app's own `Usage` (`{ input, cacheRead, cacheWrite,
 * ... }` — see ai/types.ts) on assistant messages, so `input` is the
 * uncached input tokens. Older rows (or test doubles) may report the
 * provider's split instead (`{ inputTokens, inputTokenDetails:
 * { noCacheTokens, cacheReadTokens, cacheWriteTokens } }`), so the helpers
 * below accept both shapes. This interface keeps the shared module
 * dependency-free so the web bundle and the server share one
 * implementation. */
export interface ContextUsageLike {
  /** Uncached input tokens (app shape). */
  input?: number | null;
  /** App-shape cache reads. */
  cacheRead?: number | null;
  /** App-shape cache writes. */
  cacheWrite?: number | null;
  /** Provider-shape total input tokens (Vercel LanguageModelUsage). */
  inputTokens?: number | null;
  inputTokenDetails?: {
    noCacheTokens?: number | null;
    cacheReadTokens?: number | null;
    cacheWriteTokens?: number | null;
  } | null;
}

/** Minimal message shape for context accounting (only the fields the
 * summary reads). */
export interface ContextUsageMessageLike {
  role: string;
  usage?: ContextUsageLike | null;
}

/** Session-level context summary derived from assistant `usage` rows:
 * `currentTokens` is the latest turn's input context (what the next
 * request carries), while the totals/average span the whole session. */
export interface ContextUsageSummary {
  /** Assistant turns that carried a usage object. */
  turns: number;
  /** Latest turn's input context (input + cacheRead + cacheWrite). */
  currentTokens?: number;
  /** Latest turn's cache-read tokens. */
  currentCacheRead: number;
  /** Sum of input context over every turn with usage. */
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

/** The usage's splitting convention: the app's own `Usage` shape breaks
 * input into input/cacheRead/cacheWrite fields; the Vercel provider shape
 * reports inputTokens + inputTokenDetails (noCache/cacheRead/cacheWrite).
 * The two shapes are mutually exclusive because the transport (or a test
 * double) fills exactly one of them. */
function isVercelShape(usage: ContextUsageLike): boolean {
  return typeof usage.inputTokens === "number" ||
    (usage.inputTokenDetails !== undefined &&
      usage.inputTokenDetails !== null);
}

/** Uncached input tokens of one usage row, in either shape. */
function inputTokensOf(usage: ContextUsageLike): number {
  if (isVercelShape(usage)) {
    return usageNumber(usage.inputTokenDetails?.noCacheTokens) +
      usageNumber(usage.input);
  }
  return usageNumber(usage.input);
}

/** Input context of one turn: uncached input + cache reads + cache writes.
 * All three count against the model's context window on providers that
 * report the split (e.g. Anthropic via pi-ai). In the Vercel provider
 * shape, `inputTokens` is the full prompt (cached reads included), so it
 * is the total directly; the details only split it, and counting them
 * again would double it. When the transport only reports the split (no
 * aggregate), the parts are summed. */
export function contextTokensOf(usage?: ContextUsageLike | null): number {
  if (!usage) return 0;
  if (isVercelShape(usage)) {
    const total = usageNumber(usage.inputTokens);
    if (total > 0) return total;
    return inputTokensOf(usage) +
      usageNumber(usage.inputTokenDetails?.cacheReadTokens) +
      usageNumber(usage.inputTokenDetails?.cacheWriteTokens);
  }
  return usageNumber(usage.input) + usageNumber(usage.cacheRead) +
    usageNumber(usage.cacheWrite);
}

/** Cache-read tokens of one usage row, in either shape. */
function cacheReadOf(usage: ContextUsageLike): number {
  if (isVercelShape(usage)) {
    return usageNumber(usage.inputTokenDetails?.cacheReadTokens) +
      usageNumber(usage.cacheRead);
  }
  return usageNumber(usage.cacheRead);
}

/** Summarize context usage over a transcript. Only `role === "assistant"`
 * messages with a usage object contribute; anything else (user/tool-result
 * rows, assistant rows without usage from older sessions) is ignored. */
export function summarizeContextUsage(
  messages: readonly ContextUsageMessageLike[],
): ContextUsageSummary {
  let turns = 0;
  let currentTokens: number | undefined;
  let currentCacheRead = 0;
  let totalTokens = 0;
  let totalCacheRead = 0;
  for (const message of messages) {
    if (message.role !== "assistant" || !message.usage) continue;
    const tokens = contextTokensOf(message.usage);
    const cacheRead = cacheReadOf(message.usage);
    turns++;
    currentTokens = tokens;
    currentCacheRead = cacheRead;
    totalTokens += tokens;
    totalCacheRead += cacheRead;
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

/** Ratio of the latest turn's context against the window (undefined when
 * either side is missing). Values above 1 mean the transcript already
 * exceeds the window. */
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
