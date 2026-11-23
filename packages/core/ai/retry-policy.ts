import type {
  AssistantMessage,
  NotificationMessage,
} from "../domain/message.ts";
import { sleepAbortable as sleepAbortableShared } from "../shared/misc.ts";
import { isContextOverflowText } from "./context-overflow.ts";
import { notificationMessage } from "./notification.ts";
import type { StreamFn } from "./transport.ts";

/** Maximum consecutive vacant responses (no text, no tool call) to retry
 * before giving up and ending the run normally. Shared by both retry
 * mechanisms — in-run vacant retries and silent-error restarts — so a
 * model that keeps failing can never loop forever. */
export const MAX_EMPTY_RESPONSE_RETRIES = 3;

/** True when the response produced nothing the user can see: no text and
 * no tool call. Thinking blocks alone don't count as output (the user
 * never sees them). */
export function hasNoVisibleOutput(message: AssistantMessage): boolean {
  return message.content.every(
    (block) =>
      block.type !== "toolCall" &&
      (block.type !== "text" || block.text.trim().length === 0),
  );
}

/** Error-message signatures of transient transport failures: streams cut
 * off mid-flight (the observed "Stream ended without finish_reason"),
 * connection resets, provider-side blips, and the AI SDK's own wrapper for
 * a body read that failed after a 2xx response ("Failed to process
 * successful response" / "Invalid JSON response" — the real cause lives in
 * the SDK's `APICallError.cause`, which the transport renders into the
 * message). Only these qualify for automatic restarts — a silent
 * PERMANENT failure (unconfigured or unauthorized provider, content
 * filter) has no chance of recovering, so it must surface immediately
 * instead of burning through the retry limit.
 *
 * Context overflow is deliberately NOT here: it is recoverable, but only by
 * shrinking the history first (see isContextOverflowError). */
const TRANSIENT_STREAM_ERROR_PATTERN =
  /without finish_reason|finish_reason: network_error|failed to process successful response|invalid json response|fetch failed|network|socket hang up|connection|terminated|premature close|timed out|\b(?:500|502|503|504|529)\b|overloaded/i;

/** True when the provider rejected the request for exceeding the model's
 * window: the wording classifier is shared with the transport (see
 * ai/context-overflow.ts), which may already have repaired the request by
 * shrinking its completion cap; the policy sees only the failures that
 * repair could not fix. This is the trigger the compactor's overflow
 * recovery hangs off: the request cannot succeed unchanged, and the only
 * remaining repair is a smaller history. */
export function isContextOverflowError(message: AssistantMessage): boolean {
  if (message.stopReason !== "error") return false;
  return isContextOverflowText(message.errorMessage ?? "");
}

/** True when an error-stopped response failed for a transport reason that
 * may recover. The provider's own flag (`APICallError.isRetryable`, carried
 * as `message.errorRetryable`) decides first; the wording is the fallback
 * for failures the provider did not classify. */
export function isTransientStreamError(message: AssistantMessage): boolean {
  if (message.stopReason !== "error") return false;
  if (message.errorRetryable === true) return true;
  return TRANSIENT_STREAM_ERROR_PATTERN.test(message.errorMessage ?? "");
}

/** True when the stream died before the model produced anything: an
 * error-stopped response with zero output (thinking alone doesn't count —
 * the user never sees it) whose cause looks transient. The agent loop
 * exits immediately on these turns without draining the follow-up queue,
 * so the in-run vacant-retry cannot fire; SessionAgent restarts the run
 * itself once it settles (see handleTurnEnd / resumeAfterErrorRun). An
 * unknown error message is conservatively treated as permanent. */
export function isSilentErrorResponse(message: AssistantMessage): boolean {
  return isTransientStreamError(message) && hasNoVisibleOutput(message);
}

/** The notification queued to continue a response the transport cut off
 * mid-stream. The partial text is already in the transcript, so the model
 * is told to resume rather than repeat. */
export function buildInterruptedRetryNotification(
  attempt: number,
): NotificationMessage {
  return notificationMessage({
    kind: "retry",
    title: `Previous response was cut off (retry ${attempt})`,
    body:
      "Your previous response was interrupted by a transport failure. " +
      "Continue from where it stopped — do not repeat what you already wrote.",
    status: "neutral",
  });
}

/** True when the provider cut the response at the output cap: the model was
 * still talking, so the answer is incomplete even though it looks fine.
 * Treated like an interrupted stream (continue from where it stopped), with
 * its own budget: cutting an answer short is not a transport failure. */
export function isOutputCapStop(message: AssistantMessage): boolean {
  return message.stopReason === "length";
}

/** The notification queued to continue a response the provider cut at the
 * output cap. The partial text is already in the transcript. */
export function buildOutputCapRetryNotification(
  attempt: number,
): NotificationMessage {
  return notificationMessage({
    kind: "retry",
    title: `Output limit reached (retry ${attempt})`,
    body:
      "Your previous response hit the model's output limit and was cut " +
      "off. Continue from where it stopped — do not repeat what you already " +
      "wrote.",
    status: "neutral",
  });
}

/** The notification queued to retry a vacant response. The text is
 * self-contained (no system-prompt prefix contract): the model reads it as
 * a user message telling it its previous response was empty. */
export function buildRetryNotification(attempt: number): NotificationMessage {
  return notificationMessage({
    kind: "retry",
    title: `Previous response was empty (retry ${attempt})`,
    body: "You produced neither text nor a tool call. Continue: respond with text or call a tool.",
    status: "neutral",
  });
}

/** The notification queued to retry after a provider rate-limit (429) turn.
 * Unlike the vacant-response retry, the model was cut off by throttling, not
 * by producing nothing — so the text tells it to wait and then continue. */
export function buildRateLimitRetryNotification(
  attempt: number,
): NotificationMessage {
  return notificationMessage({
    kind: "retry",
    title: `Rate limited by provider (retry ${attempt})`,
    body:
      "The provider returned a rate-limit error. Wait a moment, then continue: " +
      "respond with text or call a tool.",
    status: "neutral",
  });
}

/** The notification queued to restart a run whose request exceeded the
 * model's context window. The history is condensed before the restart (see
 * SessionAgent's compaction), so the retry asks the model to pick the work
 * back up from the checkpoint — the transcript it sees is the condensed
 * one, not the request that was rejected. */
export function buildContextOverflowRetryNotification(
  attempt: number,
): NotificationMessage {
  return notificationMessage({
    kind: "retry",
    title: `Context window exceeded (retry ${attempt})`,
    body:
      "The previous request exceeded the model's context window, so older " +
      "history was condensed into a checkpoint. Continue the work from the " +
      "current state: respond with text or call a tool.",
    status: "neutral",
  });
}

// ---- 予算表 ---------------------------------------------------------------

/** 429（レート制限）で1回の呼び出しをやり直す回数。 */
export const MAX_RATE_LIMIT_RETRIES = 5;
/** レート制限の初回バックオフ（以降は倍々）。 */
export const RATE_LIMIT_BASE_DELAY_MS = 2000;
/** バックオフの上限。 */
export const RATE_LIMIT_MAX_DELAY_MS = 60_000;

/** AI SDK自身が初回リクエストに対して行う試行回数（`StreamOptions.maxRetries`）。 */
export const PROVIDER_DEFAULT_MAX_RETRIES = 5;

/** コンテキスト超過から復帰する回数。1回で足りる（強制圧縮が履歴を縮める）。
 * 2回目の拒否は圧縮で足りなかったということなので、プロバイダーのエラーを表に出す。 */
export const MAX_OVERFLOW_RETRIES = 1;

/** 出力上限で切られた回答を続けさせる回数。 */
export const MAX_OUTPUT_CAP_RETRIES = 2;

// ---- 判定関数 -------------------------------------------------------------

/** アカウント/購読の上限。一時的な絞りではないので即座に失敗させる。 */
const NON_RETRYABLE_PATTERN = buildPattern([
  "insufficient_quota",
  "out of budget",
  "quota exceeded",
  "billing",
  "GoUsageLimitError",
  "FreeUsageLimitError",
  "Monthly usage limit reached",
  "available balance",
]);

/** やり直せるレート制限の署名: 429 の文言とゲートウェイの言い回し。 */
const RETRYABLE_PATTERN = buildPattern([
  "rate.?limit",
  "rate_limit_exceeded",
  "too many requests",
  "\\b429\\b",
]);

function buildPattern(patterns: string[]): RegExp {
  return new RegExp(patterns.join("|"), "i");
}

/** 生のエラーメッセージを分類する。Error 版と assistant メッセージ版が
 * 同じ判定を通るので、両者が食い違うことはない。 */
export function isRetryableRateLimitMessage(message: string): boolean {
  if (NON_RETRYABLE_PATTERN.test(message)) return false;
  return RETRYABLE_PATTERN.test(message);
}

export function isRetryableRateLimitError(error: unknown): boolean {
  if (!(error instanceof Error) || !error.message) return false;
  return isRetryableRateLimitMessage(error.message);
}

/** エラー停止したターンがやり直せるレート制限か。 */
export function isRetryableRateLimit(message: AssistantMessage): boolean {
  if (message.stopReason !== "error" || !message.errorMessage) return false;
  return isRetryableRateLimitMessage(message.errorMessage);
}

/** 試行回数 n のバックオフ（-25%までの揺らぎ付き、上限あり）。 */
export function rateLimitRetryDelayMs(attempt: number): number {
  return Math.round(
    Math.min(
      RATE_LIMIT_BASE_DELAY_MS * 2 ** (attempt - 1),
      RATE_LIMIT_MAX_DELAY_MS,
    ) *
      (1 - Math.random() * 0.25),
  );
}

/** バックオフの待機が中断されたときに投げるエラー。呼び出し側はこれを自分の
 * 終了状態（中断・断念）へ読み替える。 */
export class RetryAbortError extends Error {
  constructor() {
    super("Aborted during rate-limit retry backoff");
    this.name = "RetryAbortError";
  }
}

/** `signal` が発火したら RetryAbortError で拒否する待機。 */
export function sleepAbortable(
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  return sleepAbortableShared(ms, signal, () => new RetryAbortError());
}

/** すべてのLLM呼び出しにプロバイダーの試行回数を載せる。 */
export function withProviderRetryDefaults(base: StreamFn): StreamFn {
  return (model, context, options) =>
    base(model, context, applyProviderRetryDefaults(options));
}

/** 呼び出し側が指定していないときだけプロバイダーの既定値を埋める。 */
export function applyProviderRetryDefaults(
  options: Parameters<StreamFn>[2],
): Parameters<StreamFn>[2] {
  if (options === undefined) {
    return { maxRetries: PROVIDER_DEFAULT_MAX_RETRIES };
  }
  if (options.maxRetries === undefined) {
    return { ...options, maxRetries: PROVIDER_DEFAULT_MAX_RETRIES };
  }
  return options;
}

/** 次の試行の作り方。何を次に送り、どれだけ待つか、なぜやり直すのか。
 * `RetryManager` はこれを返すだけで、ループは `driveRetries` が回す。 */
export interface RetryAttempt {
  notification: NotificationMessage;
  /** この試行の前に待つミリ秒（0 ならすぐ次を試す）。 */
  delayMs: number;
  /** 何をやり直すのか: 呼び出し側の後始末（空ターンの除去、履歴の圧縮）が
   * これで決まる。 */
  reason: "vacant" | "interrupted" | "output-cap" | "rate-limit" | "overflow";
}

/** 1回の試行の結果。失敗も値として返す: ループと待機はドライバが持ち、
 * 何をやり直すかはポリシーが決める。 */
export type RetryOutcome<T> = { value: T } | { error: unknown };

/** リトライのドライバが呼ぶ3つの関数。何を次に試すかは `plan`、1回試すのは
 * `perform`、待機は `delayMs`。 */
export interface RetryDriver<A> {
  /** 次に試すこと。null で終わり（成功・打ち切り・予算切れ）。 */
  plan(): A | null;
  /** 1回試す。false を返すと打ち切る（中断・競合）。 */
  perform(attempt: A): Promise<boolean>;
  /** 試行の前に待つミリ秒。 */
  delayMs(attempt: A): number;
}

export interface RetryLoopOptions {
  /** バックオフの待機（テストで差し替える）。既定は sleepAbortable。 */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** 中断シグナル。待機の前に発火していたら待たずに降りる。 */
  signal?: AbortSignal;
}

/** すべてのリトライ経路が通る唯一のループ。`plan` → 待機 → `perform` を
 * `plan` が null を返すまで繰り返す。戻り値は最後まで走れたか（false は
 * 中断か競合で降りたことを意味する）。
 *
 * 補助呼び出しの全体再試行（streamText）、セッションの再開（RetryManager）、
 * サブエージェントの再実行（SubagentRunner）が同じループを通るので、待機と
 * 中断の扱いが1箇所に収まる。 */
export async function driveRetries<A>(
  driver: RetryDriver<A>,
  opts: RetryLoopOptions = {},
): Promise<boolean> {
  const sleepFn = opts.sleep ?? sleepAbortable;
  for (;;) {
    const attempt = driver.plan();
    if (attempt === null) return true;
    const delayMs = driver.delayMs(attempt);
    if (delayMs > 0) {
      if (opts.signal?.aborted === true) return false;
      try {
        await sleepFn(delayMs, opts.signal);
      } catch {
        // 待機中の中断: やり直さずに降りる（元の失敗が表に出る）。
        return false;
      }
    }
    if (!(await driver.perform(attempt))) return false;
  }
}

/** 1回の試行の実行結果を覚えておく枠。`plan` はここを見て次を決める。 */
interface AttemptState<T> {
  outcome: RetryOutcome<T> | null;
}

/** レート制限の再試行ポリシー: ドライバに渡す予算。 */
export interface RateLimitRetryOptions extends RetryLoopOptions {
  maxRetries?: number;
}

/** 429（レート制限）で失敗した呼び出しを共有のドライバでやり直す。
 * `isRetryable` は経路ごとに違う（Error か assistant メッセージか）ので注入する。 */
export async function retryOnRateLimitError<T>(
  attempt: () => Promise<T>,
  isRetryable: (error: unknown) => boolean,
  opts: RateLimitRetryOptions = {},
): Promise<T> {
  const maxRetries = opts.maxRetries ?? MAX_RATE_LIMIT_RETRIES;
  const state: AttemptState<T> = { outcome: null };
  let calls = 0;
  let abortedBeforeRetry = false;
  await driveRetries<{ delayMs: number }>(
    {
      plan: () => {
        if (state.outcome === null) return { delayMs: 0 };
        if ("value" in state.outcome) return null;
        if (opts.signal?.aborted === true) {
          abortedBeforeRetry = true;
          return null;
        }
        if (calls > maxRetries || !isRetryable(state.outcome.error)) {
          return null;
        }
        return { delayMs: rateLimitRetryDelayMs(calls) };
      },
      perform: async () => {
        calls++;
        try {
          state.outcome = { value: await attempt() };
        } catch (error) {
          state.outcome = { error };
        }
        return true;
      },
      delayMs: (plan) => plan.delayMs,
    },
    opts,
  );
  const outcome = state.outcome as RetryOutcome<T> | null;
  if (abortedBeforeRetry) throw new RetryAbortError();
  if (outcome === null) throw new Error("retryOnRateLimitError ran no attempt");
  // 待機中の中断は最後の失敗をそのまま返す: 呼び出し側には「やり直せなかった
  // 理由」だけが要る。
  if ("error" in outcome) throw outcome.error;
  return outcome.value;
}
