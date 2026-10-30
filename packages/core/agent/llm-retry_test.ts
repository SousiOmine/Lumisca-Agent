import { assertEquals } from "@std/assert";
import { fauxAssistantMessage } from "@lumisca/core";
import type { StreamOptions } from "../ai/types.ts";
import {
  applyProviderRetryDefaults,
  isRetryableRateLimit,
  PROVIDER_DEFAULT_MAX_RETRIES,
} from "./llm-retry.ts";

/**
 * `llm-retry.ts` is two thin adapters: a message-level view of the shared
 * rate-limit classifier (`ai/rate-limit.ts`) and the provider retry budget.
 *
 * The classifier's wording — which 429s retry and which quota limits do not
 * — is pinned once, in ai/rate-limit_test.ts. Copying that table here would
 * let the two copies drift while the implementation they describe stays
 * single. What this file has to prove is the message-level contract the
 * classifier does not cover: only an error-stopped turn is a candidate at
 * all, and the budget is filled without disturbing the caller's options.
 */

/** An error-stopped turn carrying a 429 (retryable wording). */
function rateLimited(message: string) {
  return fauxAssistantMessage("", {
    stopReason: "error",
    errorMessage: message,
  });
}

Deno.test("isRetryableRateLimit reaches the shared classifier", () => {
  // The retryable wording and its excluded quota cousins are one decision,
  // made in ai/rate-limit.ts; one round trip each way is enough to prove the
  // message shape is unwrapped and handed over.
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

Deno.test("isRetryableRateLimit: only an error stop is a candidate", () => {
  // A normal finish is never a failure, and an empty error message leaves
  // nothing to classify — neither may be retried just because a pattern
  // happens to sit in some unrelated field.
  assertEquals(isRetryableRateLimit(fauxAssistantMessage("")), false);
  assertEquals(
    isRetryableRateLimit(fauxAssistantMessage("", { stopReason: "aborted" })),
    false,
  );
  assertEquals(
    isRetryableRateLimit(fauxAssistantMessage("", {
      stopReason: "error",
      errorMessage: "",
    })),
    false,
  );
});

Deno.test("applyProviderRetryDefaults fills an unset budget", () => {
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

Deno.test("applyProviderRetryDefaults leaves a caller's budget alone", () => {
  // A caller that owns the budget keeps it — the same object, so a caller
  // comparing identity is not surprised.
  const onlyRetries: StreamOptions = { maxRetries: 1 };
  assertEquals(applyProviderRetryDefaults(onlyRetries), onlyRetries);
});
