import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  fauxAssistantMessage,
  type AssistantMessageEventStream,
  type Api,
  type Context,
  type Model,
} from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { RATE_LIMIT_BASE_DELAY_MS, RetryAbortError } from "./llm-retry.ts";
import { streamText } from "./stream-text.ts";

function fakeModel(): Model<Api> {
  return { id: "m", name: "m" } as unknown as Model<Api>;
}

/** A stream function whose call N yields the Nth outcome: {fail} emits an
 * error event with that message, otherwise a single text_delta("hi"). */
function fakeStreamFn(
  outcomes: Array<{ fail?: string }>,
): StreamFn {
  let i = 0;
  return (_model, _context: Context) => {
    const out = outcomes[i++] ?? {};
    const events = (async function* () {
      if (out.fail) {
        yield {
          type: "error",
          reason: "error",
          error: fauxAssistantMessage("", { errorMessage: out.fail }),
        };
        return;
      }
      yield {
        type: "text_delta",
        contentIndex: 0,
        delta: "hi",
        partial: fauxAssistantMessage(""),
      };
    })();
    return events as unknown as AssistantMessageEventStream;
  };
}

Deno.test("streamText accumulates text deltas", async () => {
  const text = await streamText(
    fakeStreamFn([{}]),
    fakeModel(),
    { messages: [] },
    "label",
  );
  assertEquals(text, "hi");
});

Deno.test("streamText retries a 429 then succeeds", async () => {
  let calls = 0;
  const fn = fakeStreamFn([
    { fail: "OpenAI API error (429): rate_limit_exceeded" },
    { fail: "OpenAI API error (429): rate_limit_exceeded" },
    {},
  ]);
  const streamFn = (...args: Parameters<StreamFn>) => {
    calls++;
    return fn(...args);
  };
  const text = await streamText(
    streamFn,
    fakeModel(),
    { messages: [] },
    "label",
    undefined,
    { sleep: () => Promise.resolve(), maxRetries: 5 },
  );
  assertEquals(text, "hi");
  assertEquals(calls, 3);
});

Deno.test("streamText does not retry non-rate errors", async () => {
  let calls = 0;
  const fn = fakeStreamFn([{ fail: "boom" }]);
  const streamFn = (...args: Parameters<StreamFn>) => {
    calls++;
    return fn(...args);
  };
  await assertRejects(
    () =>
      streamText(
        streamFn,
        fakeModel(),
        { messages: [] },
        "label",
        undefined,
        { sleep: () => Promise.resolve() },
      ),
    Error,
    "boom",
  );
  assertEquals(calls, 1);
});

Deno.test("streamText aborts when the signal is already set", async () => {
  let calls = 0;
  const fn = fakeStreamFn([
    { fail: "OpenAI API error (429): rate_limit_exceeded" },
  ]);
  const streamFn = (...args: Parameters<StreamFn>) => {
    calls++;
    return fn(...args);
  };
  const controller = new AbortController();
  controller.abort();
  await assertRejects(
    () =>
      streamText(
        streamFn,
        fakeModel(),
        { messages: [] },
        "label",
        { signal: controller.signal },
        { sleep: () => Promise.resolve() },
      ),
    RetryAbortError,
  );
  assertEquals(calls, 1);
});

Deno.test("streamText backoff delays grow exponentially", async () => {
  const realRandom = Math.random;
  const delays: number[] = [];
  try {
    Math.random = () => 0; // zero jitter
    const fn = fakeStreamFn([
      { fail: "429 rate_limit_exceeded" },
      { fail: "429 rate_limit_exceeded" },
      {},
    ]);
    const streamFn = (...args: Parameters<StreamFn>) => fn(...args);
    await streamText(
      streamFn,
      fakeModel(),
      { messages: [] },
      "label",
      undefined,
      {
        sleep: (ms) => {
          delays.push(ms);
          return Promise.resolve();
        },
        maxRetries: 5,
      },
    );
  } finally {
    Math.random = realRandom;
  }
  assertEquals(delays, [RATE_LIMIT_BASE_DELAY_MS, RATE_LIMIT_BASE_DELAY_MS * 2]);
  assert(delays.length === 2);
});
