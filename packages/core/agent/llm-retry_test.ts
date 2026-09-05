import { assert, assertEquals } from "@std/assert";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
  isRetryableRateLimit,
  isRetryableRateLimitError,
  MAX_RATE_LIMIT_RETRIES,
  RATE_LIMIT_BASE_DELAY_MS,
  RATE_LIMIT_MAX_DELAY_MS,
  rateLimitRetryDelayMs,
  RetryAbortError,
  retryOnRateLimitError,
  sleepAbortable,
} from "./llm-retry.ts";

function rateLimited(message: string): ReturnType<typeof fauxAssistantMessage> {
  return fauxAssistantMessage("", {
    stopReason: "error",
    errorMessage: message,
  });
}

Deno.test("isRetryableRateLimit: openai 429 rate_limit_exceeded qualifies", () => {
  assertEquals(
    isRetryableRateLimit(
      rateLimited(
        "OpenAI API error (429): Rate limit exceeded. Please retry after a brief wait.",
      ),
    ),
    true,
  );
  assertEquals(
    isRetryableRateLimit(
      rateLimited(
        "Error from provider: [rate_limit_exceeded] Rate limit exceeded",
      ),
    ),
    true,
  );
  assertEquals(
    isRetryableRateLimit(rateLimited("429 Too Many Requests")),
    true,
  );
  assertEquals(
    isRetryableRateLimit(
      rateLimited("Upstream returned HTTP 429 (too many requests)"),
    ),
    true,
  );
});

Deno.test("isRetryableRateLimit: quota/billing exhaustion does not", () => {
  assertEquals(
    isRetryableRateLimit(
      rateLimited("insufficient_quota: you have hit your quota"),
    ),
    false,
  );
  assertEquals(
    isRetryableRateLimit(rateLimited("quota exceeded for this account")),
    false,
  );
  assertEquals(
    isRetryableRateLimit(rateLimited("out of budget")),
    false,
  );
  assertEquals(
    isRetryableRateLimit(
      rateLimited("GoUsageLimitError: monthly usage limit reached"),
    ),
    false,
  );
  assertEquals(
    isRetryableRateLimit(
      rateLimited("FreeUsageLimitError: enable available balance"),
    ),
    false,
  );
});

Deno.test("isRetryableRateLimit: non-rate errors do not", () => {
  // Normal stop, outputless is not an error.
  assertEquals(isRetryableRateLimit(fauxAssistantMessage("")), false);
  assertEquals(
    isRetryableRateLimit(
      rateLimited("Provider is not configured: amazon-bedrock"),
    ),
    false,
  );
  assertEquals(
    isRetryableRateLimit(rateLimited("connection reset")),
    false,
  );
  assertEquals(
    isRetryableRateLimit(fauxAssistantMessage("", { stopReason: "aborted" })),
    false,
  );
});

Deno.test("isRetryableRateLimitError mirrors the message classifier", () => {
  assertEquals(
    isRetryableRateLimitError(
      new Error("OpenAI API error (429): rate_limit_exceeded"),
    ),
    true,
  );
  assertEquals(isRetryableRateLimitError(new Error("boom")), false);
  assertEquals(
    isRetryableRateLimitError(new Error("insufficient_quota")),
    false,
  );
  assertEquals(isRetryableRateLimitError("not an error object"), false);
});

Deno.test("rateLimitRetryDelayMs grows exponentially and is capped", () => {
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

Deno.test("rateLimitRetryDelayMs applies up to -25% jitter", () => {
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

Deno.test("sleepAbortable resolves after the delay", async () => {
  let done = false;
  const p = sleepAbortable(5).then(() => {
    done = true;
  });
  await p;
  assertEquals(done, true);
});

Deno.test("sleepAbortable rejects when the signal fires", async () => {
  const controller = new AbortController();
  const p = sleepAbortable(1000, controller.signal);
  controller.abort();
  const err = await p.then(() => null, (e) => e);
  assert(err instanceof RetryAbortError);
});

function instantSleep(): Promise<void> {
  return Promise.resolve();
}

Deno.test("retryOnRateLimitError retries rate limits then succeeds", async () => {
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

Deno.test("retryOnRateLimitError stops at non-rate errors", async () => {
  let calls = 0;
  const err = await retryOnRateLimitError(
    () => {
      calls++;
      throw new Error("boom");
    },
    isRetryableRateLimitError,
    { sleep: instantSleep },
  ).then(() => null, (e) => e);
  assertEquals((err as Error).message, "boom");
  assertEquals(calls, 1);
});

Deno.test("retryOnRateLimitError gives up after the budget", async () => {
  let calls = 0;
  const err = await retryOnRateLimitError(
    () => {
      calls++;
      throw new Error("429 rate_limit_exceeded");
    },
    isRetryableRateLimitError,
    { sleep: instantSleep, maxRetries: 2 },
  ).then(() => null, (e) => e);
  assertEquals((err as Error).message, "429 rate_limit_exceeded");
  // First attempt + 2 retries = 3 calls.
  assertEquals(calls, 3);
});

Deno.test("retryOnRateLimitError respects the default budget", async () => {
  let calls = 0;
  await retryOnRateLimitError(
    () => {
      calls++;
      throw new Error("429 rate_limit_exceeded");
    },
    isRetryableRateLimitError,
    { sleep: instantSleep },
  ).then(() => null, () => {});
  assertEquals(calls, MAX_RATE_LIMIT_RETRIES + 1);
});
