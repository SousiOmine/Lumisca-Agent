import { assertEquals, assertRejects } from "@std/assert";
import { fauxAssistantMessage } from "./faux.ts";
import {
  MAX_OUTPUT_CAP_RECOVERIES,
  MIN_RECOVERED_OUTPUT_TOKENS,
  OVERFLOW_SAFETY_TOKENS,
  recoveredOutputCap,
  withOutputCapRecovery,
} from "./output-cap-recovery.ts";
import type { StreamEvent } from "./types.ts";

/** The reported rejection, verbatim (OpenCode Go / Console Go). */
const REPORTED =
  "Upstream request failed: [invalid_request_error] This model's maximum " +
  "context length is 1048576 tokens. However, you requested 1050931 tokens " +
  "(666931 in the messages, 384000 in the completion). Please reduce the " +
  "length of the messages or completion.";

/** An overflow the provider worded without numbers. */
const UNCOUNTED = "context_length_exceeded: your prompt is too long";

Deno.test("recoveredOutputCap derives the room from the provider's counts", () => {
  // 1,048,576 - 666,931 - 1,024: the prompt left 381,645 tokens, and the
  // envelope keeps the retry strictly inside the window.
  assertEquals(
    recoveredOutputCap(REPORTED, 384_000),
    1_048_576 - 666_931 - OVERFLOW_SAFETY_TOKENS,
  );
});

Deno.test("recoveredOutputCap offers no repair when the prompt fills the window", () => {
  // The prompt alone is over the window: a smaller completion cannot help,
  // and the history has to shrink instead.
  assertEquals(
    recoveredOutputCap(
      "This model's maximum context length is 1000000 tokens. However, you " +
        "requested 1100000 tokens (999500 in the messages, 100500 in the " +
        "completion).",
      100_500,
    ),
    undefined,
  );
});

Deno.test("recoveredOutputCap halves a cap the provider never counted", () => {
  assertEquals(recoveredOutputCap(UNCOUNTED, 100_000), 50_000);
  // Without a cap to halve there is nothing to derive.
  assertEquals(recoveredOutputCap(UNCOUNTED, undefined), undefined);
  // A halving below the usable floor is not a repair.
  assertEquals(
    recoveredOutputCap(UNCOUNTED, MIN_RECOVERED_OUTPUT_TOKENS),
    undefined,
  );
});

Deno.test("recoveredOutputCap only ever narrows the cap", () => {
  // The provider's arithmetic says far more would fit, but the retry must
  // still shrink the request it just refused.
  assertEquals(
    recoveredOutputCap(
      "This model's maximum context length is 1000000 tokens. However, you " +
        "requested 110000 tokens (100000 in the messages, 10000 in the " +
        "completion).",
      10_000,
    ),
    9_999,
  );
});

Deno.test("recoveredOutputCap ignores other failures", () => {
  assertEquals(recoveredOutputCap("invalid api key", 384_000), undefined);
  assertEquals(
    recoveredOutputCap("Stream ended without finish_reason", 384_000),
    undefined,
  );
});

// ---- the recovering stream --------------------------------------------------

const START: StreamEvent = { type: "start", partial: fauxAssistantMessage("") };
const DONE: StreamEvent = { type: "done", message: fauxAssistantMessage("hi") };

function failure(text: string): StreamEvent {
  return { type: "error", errorMessage: text };
}

function delta(text: string): StreamEvent {
  return { type: "text_delta", delta: text };
}

/** One scripted attempt: events to forward, or the error to throw. */
type Attempt = { events: StreamEvent[] } | { throws: string };

/** An `open` that replays the next attempted outcome and records the cap it
 * was asked for (the recovery's observable behavior). */
function scripted(
  attempts: Attempt[],
  caps: Array<number | undefined>,
): (cap: number | undefined) => AsyncIterable<StreamEvent> {
  let index = 0;
  return (cap) => {
    caps.push(cap);
    const attempt = attempts[index++] ?? { events: [] };
    return (async function* () {
      if ("throws" in attempt) throw new Error(attempt.throws);
      for (const event of attempt.events) yield event;
    })();
  };
}

async function collect(
  stream: AsyncIterable<StreamEvent>,
): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

Deno.test("a rejected request is re-sent with the room the provider reports", async () => {
  const caps: Array<number | undefined> = [];
  const events = await collect(withOutputCapRecovery({
    initialCap: 384_000,
    open: scripted([
      { events: [START, failure(REPORTED)] },
      { events: [START, delta("hi"), DONE] },
    ], caps),
  }));

  // The retry asked for exactly the room the provider's counts leave.
  assertEquals(caps, [
    384_000,
    1_048_576 - 666_931 - OVERFLOW_SAFETY_TOKENS,
  ]);
  // The caller sees one start, the successful attempt's output and no error:
  // the turn completed as if the first request had fit.
  assertEquals(events.filter((event) => event.type === "start").length, 1);
  assertEquals(events.filter((event) => event.type === "error").length, 0);
  assertEquals(events.map((event) => event.type), [
    "start",
    "text_delta",
    "done",
  ]);
});

Deno.test("output that already streamed is never replayed", async () => {
  // A cap cannot be the cause once content arrived, and re-sending would
  // duplicate it in the transcript.
  const caps: Array<number | undefined> = [];
  const events = await collect(withOutputCapRecovery({
    initialCap: 384_000,
    open: scripted([
      { events: [START, delta("par"), failure(REPORTED)] },
    ], caps),
  }));
  assertEquals(caps.length, 1);
  assertEquals(events.map((event) => event.type), [
    "start",
    "text_delta",
    "error",
  ]);
});

Deno.test("a failure that is not a window rejection is untouched", async () => {
  const caps: Array<number | undefined> = [];
  const events = await collect(withOutputCapRecovery({
    initialCap: 384_000,
    open: scripted([{ events: [START, failure("invalid api key")] }], caps),
  }));
  assertEquals(caps, [384_000]);
  assertEquals(events.at(-1)!.type, "error");
});

Deno.test("the recovery budget bounds a provider that keeps refusing", async () => {
  const caps: Array<number | undefined> = [];
  const always = { events: [START, failure(REPORTED)] };
  const events = await collect(withOutputCapRecovery({
    initialCap: 384_000,
    open: scripted([always, always, always, always], caps),
  }));
  // One request plus MAX_OUTPUT_CAP_RECOVERIES retries, each strictly
  // smaller than its predecessor.
  assertEquals(caps.length, 1 + MAX_OUTPUT_CAP_RECOVERIES);
  for (let i = 1; i < caps.length; i++) {
    assertEquals((caps[i] as number) < (caps[i - 1] as number), true);
  }
  assertEquals(events.at(-1)!.type, "error");
});

Deno.test("a cancelled call is not retried", async () => {
  const caps: Array<number | undefined> = [];
  const controller = new AbortController();
  controller.abort();
  const events = await collect(withOutputCapRecovery({
    initialCap: 384_000,
    signal: controller.signal,
    open: scripted([{ events: [START, failure(REPORTED)] }], caps),
  }));
  assertEquals(caps.length, 1);
  assertEquals(events.at(-1)!.type, "error");
});

Deno.test("a thrown overflow is recovered the same way", async () => {
  const caps: Array<number | undefined> = [];
  const events = await collect(withOutputCapRecovery({
    initialCap: 384_000,
    open: scripted([
      { throws: REPORTED },
      { events: [START, delta("hi"), DONE] },
    ], caps),
  }));
  assertEquals(caps.length, 2);
  // The first attempt never reached its start, so the retry's start is the
  // caller's one placeholder for this turn.
  assertEquals(events.filter((event) => event.type === "start").length, 1);
  assertEquals(events.at(-1)!.type, "done");
});

Deno.test("a thrown failure that no cap can repair propagates unchanged", async () => {
  const caps: Array<number | undefined> = [];
  const stream = withOutputCapRecovery({
    initialCap: 384_000,
    open: scripted([{ throws: "invalid api key" }], caps),
  });
  await assertRejects(() => collect(stream), Error, "invalid api key");
  assertEquals(caps.length, 1);
});
