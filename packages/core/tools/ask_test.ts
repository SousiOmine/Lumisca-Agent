import { assert, assertEquals, assertRejects } from "@std/assert";
import type { ClientEvent } from "../types/event.ts";
import { AskHub, createAskTool } from "./ask.ts";

/** A hub whose emitted events are recorded, so tests can observe the
 * `question` event and resolve the ask as the HTTP layer would. */
function makeHub() {
  const events: ClientEvent[] = [];
  const hub = new AskHub("session-1", (event) => events.push(event));
  return { hub, events };
}

/** The tool call id the tests execute with. */
const TOOL_CALL_ID = "call-1";

function toolText(result: { content: { type: string; text?: string }[] }) {
  return result.content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("");
}

Deno.test("ask emits a question event and resolves with the answers", async () => {
  const { hub, events } = makeHub();
  const tool = createAskTool(hub);
  const questions = [{
    id: "q1",
    question: "Which language?",
    options: [{ label: "Deno" }, { label: "Node" }],
  }];
  const promise = tool.execute(TOOL_CALL_ID, { questions }, undefined);

  // The event goes out immediately; the run waits for the answer.
  const event = events[0] as Extract<ClientEvent, { type: "question" }>;
  assertEquals(event.type, "question");
  assertEquals(event.sessionId, "session-1");
  assertEquals(event.toolCallId, TOOL_CALL_ID);
  assertEquals(event.questions, questions);

  hub.answer(TOOL_CALL_ID, [{ id: "q1", values: ["Deno"] }]);
  const result = await promise;
  assertEquals(
    toolText(result),
    "Answers from the user:\n- Which language?: Deno",
  );
  assertEquals(result.details, { answers: [{ id: "q1", values: ["Deno"] }] });
});

Deno.test("ask with multiple questions resolves with all answers", async () => {
  const { hub } = makeHub();
  const tool = createAskTool(hub);
  const promise = tool.execute(
    TOOL_CALL_ID,
    {
      questions: [
        {
          id: "lang",
          question: "Language?",
          options: [{ label: "Deno" }, { label: "Node" }],
        },
        {
          id: "scale",
          question: "Scale?",
          multi: true,
          options: [{ label: "Small" }, { label: "Medium" }, {
            label: "Large",
          }],
          recommended: 1,
        },
      ],
    },
    undefined,
  );
  hub.answer(TOOL_CALL_ID, [
    { id: "lang", values: ["Deno"] },
    { id: "scale", values: ["Medium", "Large"] },
  ]);
  const result = await promise;
  assertEquals(
    toolText(result),
    "Answers from the user:\n- Language?: Deno\n- Scale?: Medium, Large",
  );
});

Deno.test("answer rejects for an unknown tool call id", () => {
  const { hub } = makeHub();
  assertThrowsCoreError(
    () => hub.answer("call-unknown", [{ id: "q1", values: ["Deno"] }]),
    "No pending question for tool call: call-unknown",
    "not_found",
  );
});

Deno.test("answer rejects for unknown question ids and options", async () => {
  const { hub } = makeHub();
  const tool = createAskTool(hub);
  const promise = tool.execute(
    TOOL_CALL_ID,
    {
      questions: [{
        id: "q1",
        question: "Which language?",
        options: [{ label: "Deno" }, { label: "Node" }],
      }],
    },
    undefined,
  );
  assertThrowsCoreError(
    () => hub.answer(TOOL_CALL_ID, [{ id: "q2", values: ["Deno"] }]),
    "Unknown question id: q2",
    "invalid",
  );
  assertThrowsCoreError(
    () => hub.answer(TOOL_CALL_ID, [{ id: "q1", values: ["Python"] }]),
    'Unknown option for question "q1": Python',
    "invalid",
  );
  // A rejected validation must not consume the pending ask.
  hub.answer(TOOL_CALL_ID, [{ id: "q1", values: ["Deno"] }]);
  await promise;
});

Deno.test("answer requires a value for every question", async () => {
  const { hub } = makeHub();
  const tool = createAskTool(hub);
  const promise = tool.execute(
    TOOL_CALL_ID,
    {
      questions: [
        {
          id: "q1",
          question: "One?",
          options: [{ label: "A" }, { label: "B" }],
        },
        {
          id: "q2",
          question: "Two?",
          options: [{ label: "C" }, { label: "D" }],
        },
      ],
    },
    undefined,
  );
  assertThrowsCoreError(
    () => hub.answer(TOOL_CALL_ID, [{ id: "q1", values: ["A"] }]),
    "answers must cover every question",
    "invalid",
  );
  hub.answer(TOOL_CALL_ID, [
    { id: "q1", values: ["A"] },
    { id: "q2", values: ["C"] },
  ]);
  await promise;
});

Deno.test("rejectAll rejects a pending ask (run teardown)", async () => {
  const { hub } = makeHub();
  const tool = createAskTool(hub);
  const promise = tool.execute(
    TOOL_CALL_ID,
    {
      questions: [{
        id: "q1",
        question: "Which language?",
        options: [{ label: "Deno" }, { label: "Node" }],
      }],
    },
    undefined,
  );
  hub.rejectAll();
  await assertRejects(
    () => promise,
    Error,
    `Question cancelled: ${TOOL_CALL_ID}`,
  );
  // Rejected asks are gone: a later answer must not resurrect them.
  assertThrowsCoreError(
    () => hub.answer(TOOL_CALL_ID, [{ id: "q1", values: ["Deno"] }]),
    "No pending question for tool call: call-1",
    "not_found",
  );
});

Deno.test("ask rejects duplicate question ids", async () => {
  const { hub } = makeHub();
  const tool = createAskTool(hub);
  await assertRejects(
    () =>
      tool.execute(
        TOOL_CALL_ID,
        {
          questions: [
            { id: "q1", question: "One?", options: [{ label: "A" }] },
            { id: "q1", question: "Two?", options: [{ label: "B" }] },
          ],
        },
        undefined,
      ),
    Error,
    "Duplicate question id: q1",
  );
});

Deno.test("ask rejects empty options and out-of-range recommended", async () => {
  const { hub } = makeHub();
  const tool = createAskTool(hub);
  await assertRejects(
    () =>
      tool.execute(
        TOOL_CALL_ID,
        { questions: [{ id: "q1", question: "One?", options: [] }] },
        undefined,
      ),
    Error,
    'Question "q1" has no options',
  );
  await assertRejects(
    () =>
      tool.execute(
        TOOL_CALL_ID,
        {
          questions: [{
            id: "q1",
            question: "One?",
            options: [{ label: "A" }],
            recommended: 3,
          }],
        },
        undefined,
      ),
    Error,
    "recommended index 3 is out of range",
  );
});

/** Assert that `fn` throws the core's validation error with the expected
 * message and kind (the AskHub throws CoreError, classified for HTTP). */
function assertThrowsCoreError(
  fn: () => void,
  message: string,
  kind: string,
): void {
  try {
    fn();
    assert(false, `expected an error: ${message}`);
  } catch (error) {
    assertEquals(
      error instanceof Error ? error.message : String(error),
      message,
    );
    assertEquals(
      (error as { kind?: string }).kind,
      kind,
    );
  }
}
