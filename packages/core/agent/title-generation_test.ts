import { assertEquals, assertRejects } from "@std/assert";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type {
  Api,
  AssistantMessageEventStream,
  Context,
  Model,
} from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { cleanTitle, TitleGenerator } from "./title-generation.ts";

function fakeModel(): Model<Api> {
  return {
    id: "fast",
    name: "fast",
  } as unknown as Model<Api>;
}

/** A stream function that yields one text_delta (or an error event). */
function fakeStreamFn(
  text: string,
  options: { fail?: boolean } = {},
  onCall?: (context: Context) => void,
): StreamFn {
  return (_model, context) => {
    onCall?.(context);
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
  assertEquals(cleanTitle("Fix\n  login\n bug."), "Fix login bug.");
  assertEquals(cleanTitle("x".repeat(50)), "x".repeat(30));
  assertEquals(cleanTitle("   "), "");
});

Deno.test("generateTitle returns the cleaned model output", async () => {
  const calls: Context[] = [];
  const generator = new TitleGenerator(
    fakeModel(),
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

Deno.test("generateTitle throws on stream errors", async () => {
  const generator = new TitleGenerator(
    fakeModel(),
    fakeStreamFn("", { fail: true }),
  );
  await assertRejects(
    () => generator.generateTitle("hi"),
    Error,
    "boom",
  );
});

Deno.test("generateTitle throws when the model returns no text", async () => {
  const generator = new TitleGenerator(fakeModel(), fakeStreamFn("   "));
  await assertRejects(
    () => generator.generateTitle("hi"),
    Error,
    "no text",
  );
});
