import { assertEquals } from "@std/assert";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@lumisca/core";
import type { AgentMessage } from "../ai/types.ts";
import { MAX_RATE_LIMIT_RETRIES } from "../ai/rate-limit.ts";
import { RetryManager } from "./retry-manager.ts";
import {
  isContextOverflowError,
  MAX_EMPTY_RESPONSE_RETRIES,
} from "./retry-policy.ts";

/** An error-stopped, outputless assistant turn with the given message. */
function errored(errorMessage: string): AgentMessage {
  return fauxAssistantMessage("", { stopReason: "error", errorMessage });
}

/** The assistant turn the faux provider builds for a tool call. */
function withToolCall(): AgentMessage {
  return fauxAssistantMessage([fauxToolCall("mock_tool", {})]);
}

function withText(text: string): AgentMessage {
  return fauxAssistantMessage([fauxText(text)]);
}

Deno.test("classify: progress resets both retry budgets", () => {
  const retries = new RetryManager(instantSleep);
  // Burn one vacant and one rate-limit retry, then make progress.
  retries.classify(fauxAssistantMessage(""), false);
  retries.classify(errored("429 rate_limit_exceeded"), false);
  assertEquals(retries.classify(withText("done"), false), { action: "none" });
  // The budgets are back: a fresh vacant response retries at attempt 1.
  const decision = retries.classify(fauxAssistantMessage(""), false);
  assertEquals(decision.action, "followUp");
});

Deno.test("classify: a vacant normal stop retries in-run up to the cap", () => {
  const retries = new RetryManager(instantSleep);
  for (let attempt = 1; attempt <= MAX_EMPTY_RESPONSE_RETRIES; attempt++) {
    const decision = retries.classify(fauxAssistantMessage(""), false);
    assertEquals(decision.action, "followUp");
  }
  // The budget is spent: the turn ends normally instead of looping.
  assertEquals(retries.classify(fauxAssistantMessage(""), false), {
    action: "none",
  });
});

Deno.test("classify: a tool call counts as progress", () => {
  const retries = new RetryManager(instantSleep);
  retries.classify(fauxAssistantMessage(""), false);
  assertEquals(retries.classify(withToolCall(), false), { action: "none" });
  assertEquals(
    retries.classify(fauxAssistantMessage(""), false).action,
    "followUp",
  );
});

Deno.test("classify: a rate-limited turn parks a restart with its own budget", () => {
  const retries = new RetryManager(instantSleep);
  for (let attempt = 1; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
    const decision = retries.classify(
      errored("429 rate_limit_exceeded"),
      false,
    );
    assertEquals(decision.action, "park");
    assertEquals(
      decision.action === "park" ? decision.rateLimit : false,
      true,
    );
    assertEquals(retries.hasPendingRestart, true);
  }
  // The rate-limit budget is spent; the notification stops being parked.
  assertEquals(retries.classify(errored("429 rate_limit_exceeded"), false), {
    action: "none",
  });
});

Deno.test("classify: rate-limit and vacant budgets are independent", () => {
  const retries = new RetryManager(instantSleep);
  // Spend the whole vacant budget first...
  for (let i = 0; i < MAX_EMPTY_RESPONSE_RETRIES; i++) {
    retries.classify(fauxAssistantMessage(""), false);
  }
  // ...a rate-limited turn still gets its own retries.
  assertEquals(
    retries.classify(errored("429 too many requests"), false).action,
    "park",
  );
});

Deno.test("classify: a permanent error surfaces instead of retrying", () => {
  const retries = new RetryManager(instantSleep);
  assertEquals(
    retries.classify(errored("Provider is not configured: openai"), false),
    { action: "none" },
  );
  assertEquals(retries.hasPendingRestart, false);
});

Deno.test("classify: an aborted stop is never retried", () => {
  const retries = new RetryManager(instantSleep);
  const aborted = fauxAssistantMessage("", { stopReason: "aborted" });
  assertEquals(retries.classify(aborted, false), { action: "none" });
});

Deno.test("classify: a closed session retries nothing", () => {
  const retries = new RetryManager(instantSleep);
  assertEquals(retries.classify(fauxAssistantMessage(""), true), {
    action: "none",
  });
  assertEquals(retries.classify(errored("429 rate_limit_exceeded"), true), {
    action: "none",
  });
});

Deno.test("classify: a user message is never a retry trigger", () => {
  const retries = new RetryManager(instantSleep);
  const user: AgentMessage = { role: "user", content: [], timestamp: 0 };
  assertEquals(retries.classify(user, false), { action: "none" });
});

function instantSleep(): Promise<void> {
  return Promise.resolve();
}

/** A prompt sink that records the messages handed to it. */
function recordingAgent(): {
  prompts: unknown[];
  prompt: (message: unknown) => Promise<void>;
} {
  const prompts: unknown[] = [];
  return {
    prompts,
    prompt: (message: unknown) => {
      prompts.push(message);
      return Promise.resolve();
    },
  };
}

Deno.test("resumeOnce re-prompts with the parked notification", async () => {
  const retries = new RetryManager(instantSleep);
  const decision = retries.classify(errored("429 rate_limit_exceeded"), false);
  assertEquals(decision.action, "park");
  const agent = recordingAgent();

  const resumed = await retries.resumeOnce(agent, false);
  assertEquals(resumed, true);
  assertEquals(agent.prompts.length, 1);
  assertEquals(retries.hasPendingRestart, false);
});

Deno.test("resumeOnce backs off before a rate-limit restart", async () => {
  const delays: number[] = [];
  const retries = new RetryManager((ms) => {
    delays.push(ms);
    return Promise.resolve();
  });
  retries.classify(errored("429 rate_limit_exceeded"), false);
  await retries.resumeOnce(recordingAgent(), false);
  assertEquals(delays.length, 1);
  assertEquals(delays[0]! > 0, true);
});

Deno.test("resumeOnce stands down when the backoff is aborted", async () => {
  const retries = new RetryManager(() => Promise.reject(new Error("aborted")));
  retries.classify(errored("429 rate_limit_exceeded"), false);
  const agent = recordingAgent();

  const resumed = await retries.resumeOnce(agent, false);
  assertEquals(resumed, false);
  assertEquals(agent.prompts.length, 0);
});

Deno.test("resumeOnce stands down when an abort lands between restarts", async () => {
  const retries = new RetryManager(() => {
    // The stop arrives while the backoff is running: the current restart
    // still completes, the next one must not fire.
    retries.abort();
    return Promise.resolve();
  });
  // Park both kinds so the loop has a second iteration to stand down on.
  retries.classify(errored("429 rate_limit_exceeded"), false);
  retries.classify(errored("connection reset"), false);
  assertEquals(retries.hasPendingRestart, true);

  const agent = recordingAgent();
  assertEquals(await retries.resumeOnce(agent, false), true);
  assertEquals(agent.prompts.length, 1);
  // The silent-error restart is still parked, but the abort invalidated it.
  assertEquals(retries.hasPendingRestart, true);
});

Deno.test("resumeOnce stands down when the agent rejects the prompt", async () => {
  const retries = new RetryManager(instantSleep);
  retries.classify(errored("429 rate_limit_exceeded"), false);
  const agent = {
    prompt: () => Promise.reject(new Error("another run is active")),
  };
  assertEquals(await retries.resumeOnce(agent, false), false);
});

Deno.test("resumeOnce is a no-op without a parked restart", async () => {
  const retries = new RetryManager(instantSleep);
  const agent = recordingAgent();
  assertEquals(await retries.resumeOnce(agent, false), true);
  assertEquals(agent.prompts.length, 0);
});

Deno.test("classify: a cut-off response parks a continuation", () => {
  const retries = new RetryManager(instantSleep);
  // The turn produced text and was then cut by a transport failure.
  const interrupted = fauxAssistantMessage([fauxText("partial answer")], {
    stopReason: "error",
    errorMessage: "Failed to process successful response",
  }) as AgentMessage;

  const decision = retries.classify(interrupted, false);
  assertEquals(decision.action, "park");
  assertEquals(retries.hasPendingRestart, true);
  // The continuation must tell the model to resume, not to repeat.
  assertEquals(
    decision.action === "park"
      ? decision.notification.title.includes("cut off")
      : false,
    true,
  );
});

Deno.test("classify: a permanent error with output is not retried", () => {
  const retries = new RetryManager(instantSleep);
  const rejected = fauxAssistantMessage([fauxText("partial answer")], {
    stopReason: "error",
    errorMessage: "invalid api key",
  }) as AgentMessage;
  assertEquals(retries.classify(rejected, false), { action: "none" });
  assertEquals(retries.hasPendingRestart, false);
});

Deno.test("classify: a normal answer is progress, not an interruption", () => {
  const retries = new RetryManager(instantSleep);
  assertEquals(retries.classify(withText("done"), false), { action: "none" });
});

Deno.test("classify: the interruption budget is bounded", () => {
  const retries = new RetryManager(instantSleep);
  const interrupted = () =>
    fauxAssistantMessage([fauxText("partial")], {
      stopReason: "error",
      errorMessage: "Failed to process successful response",
    }) as AgentMessage;
  for (let attempt = 1; attempt <= MAX_EMPTY_RESPONSE_RETRIES; attempt++) {
    assertEquals(retries.classify(interrupted(), false).action, "park");
  }
  // A provider that keeps dropping long streams must not loop forever.
  assertEquals(retries.classify(interrupted(), false), { action: "none" });
});

Deno.test("classify: a closed session never parks an interruption", () => {
  const retries = new RetryManager(instantSleep);
  const interrupted = fauxAssistantMessage([fauxText("partial")], {
    stopReason: "error",
    errorMessage: "Failed to process successful response",
  }) as AgentMessage;
  assertEquals(retries.classify(interrupted, true), { action: "none" });
});

Deno.test("reset clears a parked interruption", () => {
  const retries = new RetryManager(instantSleep);
  retries.classify(
    fauxAssistantMessage([fauxText("partial")], {
      stopReason: "error",
      errorMessage: "Failed to process successful response",
    }) as AgentMessage,
    false,
  );
  assertEquals(retries.hasPendingRestart, true);
  retries.reset();
  assertEquals(retries.hasPendingRestart, false);
});

Deno.test("reset clears the budgets and the parked restarts", () => {
  const retries = new RetryManager(instantSleep);
  retries.classify(fauxAssistantMessage(""), false);
  retries.classify(errored("429 rate_limit_exceeded"), false);
  assertEquals(retries.hasPendingRestart, true);

  retries.reset();
  assertEquals(retries.hasPendingRestart, false);
  // The budgets are fresh: the next vacant response is attempt 1 again
  // (a spent budget would answer "none").
  assertEquals(
    retries.classify(fauxAssistantMessage(""), false).action,
    "followUp",
  );
});

Deno.test("isContextOverflowError: provider window rejections are classified", () => {
  // The reported failure (OpenCode Go / Console Go wording).
  assertEquals(
    isContextOverflowError(fauxAssistantMessage("", {
      stopReason: "error",
      errorMessage:
        "Error from provider (Console Go): This model's maximum context " +
        "length is 1048576 tokens. However, you requested 1049871 tokens " +
        "(665871 in the messages, 384000 in the completion). Please reduce " +
        "the length of the messages or completion.",
    })),
    true,
  );
  // Other providers' wordings for the same condition.
  assertEquals(
    isContextOverflowError(fauxAssistantMessage("", {
      stopReason: "error",
      errorMessage: "context_length_exceeded: your prompt is too long",
    })),
    true,
  );
  assertEquals(
    isContextOverflowError(fauxAssistantMessage("", {
      stopReason: "error",
      errorMessage: "The input token count exceeds the maximum",
    })),
    true,
  );
});

Deno.test("isContextOverflowError: other failures are not overflows", () => {
  // A transport cut is retried by the transient path, not by compaction.
  assertEquals(
    isContextOverflowError(fauxAssistantMessage("", {
      stopReason: "error",
      errorMessage: "Stream ended without finish_reason",
    })),
    false,
  );
  // A permanent configuration failure has nothing to compact away.
  assertEquals(
    isContextOverflowError(fauxAssistantMessage("", {
      stopReason: "error",
      errorMessage: "invalid api key",
    })),
    false,
  );
  // A normal stop is never an overflow, whatever it says.
  assertEquals(
    isContextOverflowError(fauxAssistantMessage("maximum context length")),
    false,
  );
});

Deno.test("classify: a context overflow parks a restart that condenses first", () => {
  const retries = new RetryManager(instantSleep);
  const decision = retries.classify(
    fauxAssistantMessage("", {
      stopReason: "error",
      errorMessage:
        "This model's maximum context length is 1000 tokens. Please reduce " +
        "the length of the messages or completion.",
    }),
    false,
  );
  assertEquals(decision.action, "park");
  if (decision.action !== "park") throw new Error("expected park");
  assertEquals(decision.overflow, true);
  assertEquals(retries.hasPendingOverflow, true);
  assertEquals(decision.notification.title.includes("Context window"), true);
});

Deno.test("classify: a second overflow surfaces instead of retrying", () => {
  const retries = new RetryManager(instantSleep);
  const overflow = () =>
    fauxAssistantMessage("", {
      stopReason: "error",
      errorMessage: "This model's maximum context length is 1000 tokens.",
    });
  retries.classify(overflow(), false);
  // The retry was already spent: the provider's own error must stand.
  assertEquals(retries.classify(overflow(), false), { action: "none" });
  assertEquals(retries.hasPendingOverflow, true);
});

Deno.test("abort and reset clear a parked overflow", () => {
  const retries = new RetryManager(instantSleep);
  retries.classify(
    fauxAssistantMessage("", {
      stopReason: "error",
      errorMessage: "This model's maximum context length is 1000 tokens.",
    }),
    false,
  );
  assertEquals(retries.hasPendingOverflow, true);
  retries.reset();
  assertEquals(retries.hasPendingOverflow, false);
  // The budget is reset too: a fresh exchange gets its recovery back.
  assertEquals(
    retries.classify(
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "This model's maximum context length is 1000 tokens.",
      }),
      false,
    ).action,
    "park",
  );
});
