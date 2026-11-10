import { fakeModel } from "../test-utils.ts";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { fauxAssistantMessage } from "@lumisca/core";
import type { AssistantMessageEventStream, StreamRequest } from "@lumisca/core";
import type { StreamOptions } from "../ai/types.ts";
import type { StreamFn } from "@lumisca/core";
import {
  cleanTitle,
  MAX_TITLE_CHARS,
  TITLE_MAX_OUTPUT_TOKENS,
  TitleGenerator,
  titleSystemPrompt,
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

Deno.test("the prompt names the cap that cleanTitle enforces", () => {
  for (const language of ["ja", "en"] as const) {
    assert(
      titleSystemPrompt(language).includes(
        `at most ${MAX_TITLE_CHARS} characters`,
      ),
    );
  }
});

Deno.test("the prompt shows an example in the title's own language", () => {
  const ja = titleSystemPrompt("ja");
  assert(ja.includes("スマホのログイン不具合を修正"));
  assert(ja.includes("<message>"), "the example must show its input");
  const en = titleSystemPrompt("en");
  assert(en.includes("Fix mobile login button"));
  assertEquals(en.includes("スマホ"), false, "an English sample, in English");
});

Deno.test("the examples are already the final shape", () => {
  // A sample the model copies must survive the cleaner unchanged and obey
  // the cap it teaches; otherwise it demonstrates a title we would rewrite.
  for (const language of ["ja", "en"] as const) {
    const example = titleSystemPrompt(language).split("\n").at(-1)!;
    assert(example.length <= MAX_TITLE_CHARS, example);
    assertEquals(cleanTitle(example), example);
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
  // The call carried the first message and the title system prompt.
  assertEquals(calls.length, 1);
  const content = calls[0]!.messages[0]!.content as Array<{ text: string }>;
  assertEquals(content[0]!.text, "Please fix the login bug");
  assertEquals(calls[0]!.systemPrompt?.includes("title"), true);
});

Deno.test("generateTitle bounds its output and follows the session language", async () => {
  let seen: StreamOptions | undefined;
  let prompt = "";
  const generator = new TitleGenerator(
    fakeModel("fast"),
    fakeStreamFn("Fix login bug", {}, (request, streamOptions) => {
      seen = streamOptions;
      prompt = request.systemPrompt ?? "";
    }),
  );

  await generator.generateTitle("fix the login bug", "ja");

  // A runaway answer cannot spend the fast model's whole output budget.
  assertEquals(seen?.maxOutputTokens, TITLE_MAX_OUTPUT_TOKENS);
  // The example follows the session, not the message.
  assert(prompt.includes("スマホのログイン不具合を修正"));
  assert(prompt.includes("Japanese"));
});

Deno.test("generateTitle throws on stream errors", async () => {
  const generator = new TitleGenerator(
    fakeModel("fast"),
    fakeStreamFn("", { fail: true }),
  );
  await assertRejects(
    () => generator.generateTitle("hi"),
    Error,
    "boom",
  );
});

Deno.test("generateTitle throws when the model returns no text", async () => {
  const generator = new TitleGenerator(fakeModel("fast"), fakeStreamFn("   "));
  await assertRejects(
    () => generator.generateTitle("hi"),
    Error,
    "no text",
  );
});
