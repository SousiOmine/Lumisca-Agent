import { test } from "bun:test";
import {
  fauxAssistantMessage,
  fauxText,
  fauxThinking,
  fauxToolCall,
} from "@lumisca/core";
import { assert, assertEquals } from "@std/assert";
import type { AssistantMessage } from "../domain/message.ts";
import {
  applyProviderRetryDefaults,
  buildInterruptedRetryNotification,
  buildRetryNotification,
  hasNoVisibleOutput,
  isRetryableRateLimit,
  isRetryableRateLimitError,
  isSilentErrorResponse,
  isTransientStreamError,
  MAX_RATE_LIMIT_RETRIES,
  PROVIDER_DEFAULT_MAX_RETRIES,
  RATE_LIMIT_BASE_DELAY_MS,
  RATE_LIMIT_MAX_DELAY_MS,
  RetryAbortError,
  rateLimitRetryDelayMs,
  retryOnRateLimitError,
  sleepAbortable,
} from "./retry-policy.ts";
import type { StreamOptions } from "./transport.ts";

function errored(
  errorMessage: string,
  extra: Record<string, unknown> = {},
  content = [] as AssistantMessage["content"],
): AssistantMessage {
  return fauxAssistantMessage(content, {
    stopReason: "error",
    errorMessage,
    ...extra,
  }) as AssistantMessage;
}

test("isTransientStreamError classifies the AI SDK body-read wrapper", () => {
  // The exact text observed when a 2xx body read died mid-stream.
  assertEquals(
    isTransientStreamError(errored("Failed to process successful response")),
    true,
  );
  assertEquals(
    isTransientStreamError(
      errored(
        "Failed to process successful response (status 200; cause Error: " +
          "error reading a body from connection)",
      ),
    ),
    true,
  );
  assertEquals(isTransientStreamError(errored("Invalid JSON response")), true);
});

test("a 429 stays the rate-limit classifier's job", () => {
  // The two classifiers are deliberately separate: a throttle is retried
  // with its own budget and its own backoff, not as a transport fault.
  const throttled = errored("429 rate_limit_exceeded");
  assertEquals(isRetryableRateLimit(throttled), true);
  assertEquals(isTransientStreamError(throttled), false);
});

test("isTransientStreamError trusts the provider's retryable flag", () => {
  // A wording the pattern does not know, but the provider classified it.
  assertEquals(
    isTransientStreamError(
      errored("upstream hiccup", { errorRetryable: true }),
    ),
    true,
  );
});

test("isTransientStreamError leaves permanent failures alone", () => {
  assertEquals(
    isTransientStreamError(errored("Provider is not configured: bedrock")),
    false,
  );
  assertEquals(isTransientStreamError(errored("invalid api key")), false);
  // Only error stops qualify: a normal finish is never a failure.
  assertEquals(isTransientStreamError(fauxAssistantMessage("done")), false);
  assertEquals(
    isTransientStreamError(fauxAssistantMessage("", { stopReason: "aborted" })),
    false,
  );
});

test("isSilentErrorResponse requires an outputless transient failure", () => {
  assertEquals(
    isSilentErrorResponse(errored("Failed to process successful response")),
    true,
  );
  // Same failure, but the response had already produced text: it is an
  // interruption, not a silent error.
  assertEquals(
    isSilentErrorResponse(
      errored("Failed to process successful response", {}, [
        fauxText("partial answer"),
      ]),
    ),
    false,
  );
  // Outputless but permanent.
  assertEquals(
    isSilentErrorResponse(errored("Provider is not configured: openai")),
    false,
  );
});

test("buildInterruptedRetryNotification tells the model to resume", () => {
  const notification = buildInterruptedRetryNotification(2);
  assertEquals(notification.kind, "retry");
  assertEquals(notification.title.includes("retry 2"), true);
  // Resuming must not re-do the work already in the transcript.
  assertEquals(
    notification.body.includes("Continue from where it stopped"),
    true,
  );
  assertEquals(notification.body.includes("do not repeat"), true);
  assertEquals(notification.status, "neutral");
});

// --- the vacant-response half -------------------------------------------------

test("hasNoVisibleOutput: thinking alone is not output", () => {
  assertEquals(hasNoVisibleOutput(fauxAssistantMessage("")), true);
  assertEquals(
    hasNoVisibleOutput(
      fauxAssistantMessage([{ type: "thinking", thinking: "..." }]),
    ),
    true,
  );
});

test("hasNoVisibleOutput: text or a tool call counts as output", () => {
  assertEquals(hasNoVisibleOutput(fauxAssistantMessage("Hello")), false);
  assertEquals(
    hasNoVisibleOutput(
      fauxAssistantMessage([fauxToolCall("read", { path: "a.txt" })]),
    ),
    false,
  );
  // Thinking alongside text is still output: some of it reached the user.
  assertEquals(
    hasNoVisibleOutput(
      fauxAssistantMessage([fauxThinking("..."), fauxText("Hi")]),
    ),
    false,
  );
});

test("buildRetryNotification: self-contained continue instruction", () => {
  // The retry text is read as a user message with no system-prompt contract
  // behind it, so it has to say everything itself.
  const notification = buildRetryNotification(2);
  assertEquals(notification.role, "notification");
  assertEquals(notification.kind, "retry");
  assertEquals(notification.status, "neutral");
  assertEquals(notification.title.includes("2"), true);
  assertEquals(notification.body.includes("Continue"), true);
});

test("isSilentErrorResponse: the observed stream cut is a silent error", () => {
  // What a real provider sent (deepseek-v4-flash via opencode-go): thinking
  // streamed, then the stream ended without a finish_reason.
  assertEquals(
    isSilentErrorResponse(
      errored("Stream ended without finish_reason", {}, [
        { type: "thinking", thinking: "..." },
      ]),
    ),
    true,
  );
});

// ---- レート制限の再試行 ----------------------------------------------------

test("isRetryableRateLimitError classifies 429 wording as retryable", () => {
  assertEquals(
    isRetryableRateLimitError(
      new Error("OpenAI API error (429): rate_limit_exceeded"),
    ),
    true,
  );
  assertEquals(
    isRetryableRateLimitError(new Error("429 Too Many Requests")),
    true,
  );
  assertEquals(isRetryableRateLimitError(new Error("boom")), false);
  assertEquals(
    isRetryableRateLimitError(new Error("insufficient_quota")),
    false,
  );
  assertEquals(isRetryableRateLimitError("not an error object"), false);
});

test("rateLimitRetryDelayMs grows exponentially and is capped", () => {
  // Deterministic: override Math.random so jitter is zero.
  const realRandom = Math.random;
  try {
    Math.random = () => 0;
    assertEquals(rateLimitRetryDelayMs(1), RATE_LIMIT_BASE_DELAY_MS); // 2000
    assertEquals(rateLimitRetryDelayMs(2), RATE_LIMIT_BASE_DELAY_MS * 2); // 4000
    assertEquals(rateLimitRetryDelayMs(3), RATE_LIMIT_BASE_DELAY_MS * 4); // 8000
    assertEquals(rateLimitRetryDelayMs(4), RATE_LIMIT_BASE_DELAY_MS * 8); // 16000
    assertEquals(rateLimitRetryDelayMs(5), RATE_LIMIT_BASE_DELAY_MS * 16); // 32000
    // Capped at the max even for larger attempts.
    assertEquals(rateLimitRetryDelayMs(10), RATE_LIMIT_MAX_DELAY_MS);
    assert(rateLimitRetryDelayMs(6) <= RATE_LIMIT_MAX_DELAY_MS);
  } finally {
    Math.random = realRandom;
  }
});

test("rateLimitRetryDelayMs applies up to -25% jitter", () => {
  // Random = 1 → factor (1 - 0.25) = 0.75.
  const realRandom = Math.random;
  try {
    Math.random = () => 1;
    assertEquals(
      rateLimitRetryDelayMs(1),
      Math.round(RATE_LIMIT_BASE_DELAY_MS * 0.75),
    );
  } finally {
    Math.random = realRandom;
  }
});

test("sleepAbortable rejects when the signal fires", async () => {
  const controller = new AbortController();
  const p = sleepAbortable(1000, controller.signal);
  controller.abort();
  const err = await p.then(
    () => null,
    (e) => e,
  );
  assert(err instanceof RetryAbortError);
});

function instantSleep(): Promise<void> {
  return Promise.resolve();
}

test("retryOnRateLimitError retries rate limits then succeeds", async () => {
  let calls = 0;
  const result = await retryOnRateLimitError(
    () => {
      calls++;
      if (calls < 3) {
        throw new Error("OpenAI API error (429): rate_limit_exceeded");
      }
      return Promise.resolve("ok");
    },
    isRetryableRateLimitError,
    { sleep: instantSleep, maxRetries: 5 },
  );
  assertEquals(result, "ok");
  assertEquals(calls, 3);
});

test("retryOnRateLimitError stops at non-rate errors", async () => {
  let calls = 0;
  const err = await retryOnRateLimitError(
    () => {
      calls++;
      throw new Error("boom");
    },
    isRetryableRateLimitError,
    { sleep: instantSleep },
  ).then(
    () => null,
    (e) => e,
  );
  assertEquals((err as Error).message, "boom");
  assertEquals(calls, 1);
});

test("retryOnRateLimitError gives up after the budget", async () => {
  let calls = 0;
  const err = await retryOnRateLimitError(
    () => {
      calls++;
      throw new Error("429 rate_limit_exceeded");
    },
    isRetryableRateLimitError,
    { sleep: instantSleep, maxRetries: 2 },
  ).then(
    () => null,
    (e) => e,
  );
  assertEquals((err as Error).message, "429 rate_limit_exceeded");
  // First attempt + 2 retries = 3 calls.
  assertEquals(calls, 3);
});

test("retryOnRateLimitError respects the default budget", async () => {
  let calls = 0;
  await retryOnRateLimitError(
    () => {
      calls++;
      throw new Error("429 rate_limit_exceeded");
    },
    isRetryableRateLimitError,
    { sleep: instantSleep },
  ).then(
    () => null,
    () => {},
  );
  assertEquals(calls, MAX_RATE_LIMIT_RETRIES + 1);
});

test("retryOnRateLimitError aborts during backoff with RetryAbortError", async () => {
  const controller = new AbortController();
  const err = await retryOnRateLimitError(
    () => {
      throw new Error("429 rate_limit_exceeded");
    },
    isRetryableRateLimitError,
    {
      // The injected sleep aborts the signal instead of waiting.
      sleep: () => {
        controller.abort();
        return Promise.reject(new RetryAbortError());
      },
      signal: controller.signal,
    },
  ).then(
    () => null,
    (e) => e,
  );
  assertEquals((err as Error).message, "429 rate_limit_exceeded");
});

// ---- プロバイダーの既定値 ---------------------------------------------------

/** 分類器の文言表（どの429をやり直し、どの上限はやり直さないか）は、この
 * ファイルの「レート制限の再試行」節が一度だけ固定している。ここで確かめるのは
 * メッセージ版の契約（エラー停止したターンだけが候補）と、呼び出し側の
 * オプションを壊さずに既定値を埋めることだけ。 */

/** An error-stopped turn carrying a 429 (retryable wording). */
function rateLimited(message: string) {
  return fauxAssistantMessage("", {
    stopReason: "error",
    errorMessage: message,
  });
}

test("isRetryableRateLimit reaches the shared classifier", () => {
  // やり直せる文言と除外する上限は1つの判定: 両方向に1往復すれば、メッセージの
  // 形が剥がされて同じ判定へ渡っていることが示せる。
  assertEquals(
    isRetryableRateLimit(
      rateLimited("OpenAI API error (429): rate_limit_exceeded"),
    ),
    true,
  );
  assertEquals(
    isRetryableRateLimit(rateLimited("insufficient_quota: out of budget")),
    false,
  );
  assertEquals(isRetryableRateLimit(rateLimited("connection reset")), false);
});

test("isRetryableRateLimit: only an error stop is a candidate", () => {
  // A normal finish is never a failure, and an empty error message leaves
  // nothing to classify — neither may be retried just because a pattern
  // happens to sit in some unrelated field.
  assertEquals(isRetryableRateLimit(fauxAssistantMessage("")), false);
  assertEquals(
    isRetryableRateLimit(fauxAssistantMessage("", { stopReason: "aborted" })),
    false,
  );
  assertEquals(
    isRetryableRateLimit(
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "",
      }),
    ),
    false,
  );
});

test("applyProviderRetryDefaults fills an unset budget", () => {
  assertEquals(applyProviderRetryDefaults(undefined), {
    maxRetries: PROVIDER_DEFAULT_MAX_RETRIES,
  });
  // A caller that set no budget gets the default, keeping its own fields
  // (here: the abort signal) intact.
  const signal = new AbortController().signal;
  assertEquals(applyProviderRetryDefaults({ signal }), {
    signal,
    maxRetries: PROVIDER_DEFAULT_MAX_RETRIES,
  });
});

test("applyProviderRetryDefaults leaves a caller's budget alone", () => {
  // A caller that owns the budget keeps it — the same object, so a caller
  // comparing identity is not surprised.
  const onlyRetries: StreamOptions = { maxRetries: 1 };
  assertEquals(applyProviderRetryDefaults(onlyRetries), onlyRetries);
});
