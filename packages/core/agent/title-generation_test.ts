import type {
  AssistantMessageEventStream,
  StreamFn,
  StreamRequest,
} from "@lumisca/core";
import { fauxAssistantMessage } from "@lumisca/core";
import { assert, assertEquals, assertRejects } from "@std/assert";
import type { StreamOptions } from "../ai/types.ts";
import { fakeModel } from "../test-utils.ts";
import {
  cleanTitle,
  MAX_TITLE_CHARS,
  TitleGenerator,
  titleInstruction,
} from "./title-generation.ts";

/** A stream function that yields one text_delta (or an error event). */
function fakeStreamFn(
  text: string,
  options: { fail?: boolean } = {},
  onCall?: (request: StreamRequest, streamOptions?: StreamOptions) => void,
): StreamFn {
  return (_model, request, streamOptions) => {
    onCall?.(request, streamOptions);
    const events = (async function* () {
      if (options.fail) {
        yield {
          type: "error",
          reason: "error",
          error: fauxAssistantMessage("", { errorMessage: "boom" }),
        };
        return;
      }
      yield {
        type: "text_delta",
        contentIndex: 0,
        delta: text,
        partial: fauxAssistantMessage(""),
      };
    })();
    return events as unknown as AssistantMessageEventStream;
  };
}

Deno.test("cleanTitle strips quotes, collapses whitespace, caps at 30 chars", () => {
  assertEquals(cleanTitle('"Fix login bug"'), "Fix login bug");
  assertEquals(cleanTitle("'  Fix login bug  '"), "Fix login bug");
  assertEquals(cleanTitle("Fix\n  login\n bug."), "Fix login bug");
  assertEquals(cleanTitle("x".repeat(50)), "x".repeat(30));
  assertEquals(cleanTitle("   "), "");
});

Deno.test("cleanTitle drops a closing sentence mark", () => {
  // A title is a label, not a sentence. The prompt stopped asking for this,
  // so the code has to guarantee it instead.
  assertEquals(cleanTitle("Fix the login bug."), "Fix the login bug");
  assertEquals(cleanTitle("ログイン不具合を修正。"), "ログイン不具合を修正");
  assertEquals(cleanTitle("Fix the login bug．"), "Fix the login bug");
});

Deno.test("the instruction names the cap and the answer language", () => {
  for (const language of ["ja", "en"] as const) {
    const instruction = titleInstruction(language);
    assert(instruction.includes(`at most ${MAX_TITLE_CHARS} characters`));
    assert(instruction.includes("Answer with the title alone."));
    assert(instruction.includes("<message>"), "it names where the input goes");
  }
  assert(titleInstruction("ja").includes("Japanese"));
  assert(titleInstruction("en").includes("English"));
});

Deno.test("the instruction carries no worked example", () => {
  // Regression: a sample in the prompt was copied as the title (the session
  // was named after the sample's topic), or the model answered the task the
  // sample describes and the reply was cut to the cap. The message must be
  // the only text the model can read as a task.
  for (const language of ["ja", "en"] as const) {
    const instruction = titleInstruction(language);
    assertEquals(instruction.includes("スマホ"), false);
    assertEquals(instruction.includes("login button"), false);
  }
});

Deno.test("generateTitle returns the cleaned model output", async () => {
  const calls: StreamRequest[] = [];
  const generator = new TitleGenerator(
    fakeModel("fast"),
    fakeStreamFn('"Fix login bug"', {}, (c) => calls.push(c)),
  );

  const title = await generator.generateTitle("Please fix the login bug");

  assertEquals(title, "Fix login bug");
  // One turn carries the instruction and the message, and no system prompt.
  assertEquals(calls.length, 1);
  const content = calls[0]!.messages[0]!.content as Array<{ text: string }>;
  assertEquals(
    content[0]!.text,
    `${titleInstruction("ja")}\n\n<message>Please fix the login bug</message>`,
  );
  assertEquals(calls[0]!.systemPrompt, undefined);
});

Deno.test("generateTitle sends no output cap and follows the session language", async () => {
  let seen: StreamOptions | undefined;
  let request = "";
  const generator = new TitleGenerator(
    fakeModel("fast"),
    fakeStreamFn("Fix login bug", {}, (r, streamOptions) => {
      seen = streamOptions;
      const content = r.messages[0]!.content as Array<{ text: string }>;
      request = content[0]!.text;
    }),
  );

  await generator.generateTitle("fix the login bug", "ja");

  // Regression: a cap sized for the title alone (128) was spent entirely on
  // a reasoning model's thinking tokens, so the answer was empty and the
  // session kept its provisional name. The transport's cap is the bound.
  assertEquals(seen?.maxOutputTokens, undefined);
  // The language follows the session, not the message.
  assert(request.includes("Japanese"));
  assertEquals(request.includes("English"), false);
});

Deno.test("generateTitle throws on stream errors", async () => {
  const generator = new TitleGenerator(
    fakeModel("fast"),
    fakeStreamFn("", { fail: true }),
  );
  await assertRejects(() => generator.generateTitle("hi"), Error, "boom");
});

Deno.test("generateTitle throws when the model returns no text", async () => {
  const generator = new TitleGenerator(fakeModel("fast"), fakeStreamFn("   "));
  await assertRejects(() => generator.generateTitle("hi"), Error, "no text");
});
