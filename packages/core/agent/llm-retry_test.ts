import { assertEquals } from "@std/assert";
import { fauxAssistantMessage } from "@lumisca/core";
import type { StreamOptions } from "../ai/types.ts";
import {
  applyProviderRetryDefaults,
  isRetryableRateLimit,
  PROVIDER_DEFAULT_MAX_RETRIES,
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
  // A caller that owns the budget keeps it.
  const onlyRetries: StreamOptions = { maxRetries: 1 };
  assertEquals(applyProviderRetryDefaults(onlyRetries), onlyRetries);
});
