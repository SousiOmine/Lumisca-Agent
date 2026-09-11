import { assertEquals } from "@std/assert";
import { fauxAssistantMessage, fauxText } from "@lumisca/core";
import type { AssistantMessage } from "../ai/types.ts";
import { isRetryableRateLimit } from "./llm-retry.ts";
import {
  buildInterruptedRetryNotification,
  isSilentErrorResponse,
  isTransientStreamError,
} from "./retry-policy.ts";

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

Deno.test("isTransientStreamError classifies the AI SDK body-read wrapper", () => {
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
  assertEquals(
    isTransientStreamError(errored("Invalid JSON response")),
    true,
  );
});

Deno.test("a 429 stays the rate-limit classifier's job", () => {
  // The two classifiers are deliberately separate: a throttle is retried
  // with its own budget and its own backoff, not as a transport fault.
  const throttled = errored("429 rate_limit_exceeded");
  assertEquals(isRetryableRateLimit(throttled), true);
  assertEquals(isTransientStreamError(throttled), false);
});

Deno.test("isTransientStreamError trusts the provider's retryable flag", () => {
  // A wording the pattern does not know, but the provider classified it.
  assertEquals(
    isTransientStreamError(
      errored("upstream hiccup", { errorRetryable: true }),
    ),
    true,
  );
});

Deno.test("isTransientStreamError leaves permanent failures alone", () => {
  assertEquals(
    isTransientStreamError(errored("Provider is not configured: bedrock")),
    false,
  );
  assertEquals(isTransientStreamError(errored("invalid api key")), false);
  // Only error stops qualify: a normal finish is never a failure.
  assertEquals(isTransientStreamError(fauxAssistantMessage("done")), false);
  assertEquals(
    isTransientStreamError(
      fauxAssistantMessage("", { stopReason: "aborted" }),
    ),
    false,
  );
});

Deno.test("isSilentErrorResponse requires an outputless transient failure", () => {
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

Deno.test("buildInterruptedRetryNotification tells the model to resume", () => {
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
