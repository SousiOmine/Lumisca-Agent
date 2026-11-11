/**
 * The sentinel that says "nothing to report".
 *
 * The default is to speak: a run that forgets to decide says something rather
 * than nothing. These pin the other half — that a run which DOES ask for
 * silence actually gets it, and that a stray token never eats a real answer.
 */
import { assertEquals } from "@std/assert";
import {
  assistantTextVerdict,
  isExactNoResponse,
  NO_RESPONSE,
  stripStrayNoResponse,
} from "./silent-reply.ts";

Deno.test("the sentinel alone is silence", () => {
  assertEquals(isExactNoResponse(NO_RESPONSE), true);
  assertEquals(isExactNoResponse(`  ${NO_RESPONSE}  `), true);
  assertEquals(isExactNoResponse(""), false);
  assertEquals(isExactNoResponse("done"), false);
});

Deno.test("the sentinel repeated per turn is still silence", () => {
  // A model re-emits it after each tool batch; the segments of one turn are
  // joined with no separator, so this is one run, not prose.
  assertEquals(isExactNoResponse(`${NO_RESPONSE}${NO_RESPONSE}`), true);
  assertEquals(isExactNoResponse(`${NO_RESPONSE}\n${NO_RESPONSE}\n`), true);
});

Deno.test("a sentinel with prose is an answer, not silence", () => {
  // Fail closed: dropping the text around a token would lose what the agent
  // actually said, which is the failure this whole design exists to prevent.
  assertEquals(isExactNoResponse(`${NO_RESPONSE} done`), false);
  assertEquals(isExactNoResponse(`done ${NO_RESPONSE}`), false);
  assertEquals(
    isExactNoResponse(`I considered ${NO_RESPONSE} but wrote this`),
    false,
  );
});

Deno.test("a token inside a word is a word", () => {
  // `NO_RESPONSE_POLICY` is an identifier the agent wrote, not a sentinel.
  assertEquals(
    stripStrayNoResponse("NO_RESPONSE_POLICY is the name"),
    "NO_RESPONSE_POLICY is the name",
  );
});

Deno.test("stray sentinels at the edges are removed; the rest stays", () => {
  assertEquals(
    stripStrayNoResponse(`${NO_RESPONSE}\nthe answer`),
    "the answer",
  );
  assertEquals(
    stripStrayNoResponse(`the answer\n${NO_RESPONSE}`),
    "the answer",
  );
  // Silence itself is left alone: the caller decides what silence means.
  assertEquals(stripStrayNoResponse(NO_RESPONSE), NO_RESPONSE);
});

Deno.test("the verdict a conversation draws from one message", () => {
  assertEquals(assistantTextVerdict(NO_RESPONSE), { kind: "silent" });
  assertEquals(assistantTextVerdict("  "), { kind: "empty" });
  assertEquals(assistantTextVerdict("the answer"), {
    kind: "message",
    text: "the answer",
  });
  assertEquals(assistantTextVerdict(`${NO_RESPONSE} the answer`), {
    kind: "message",
    text: "the answer",
  });
});
