import { assertEquals } from "@std/assert";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type {
  Api,
  AssistantMessageEventStream,
  Context,
  ImageContent,
  Model,
  TextContent,
} from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { ImageAnalyzer } from "./image-analysis.ts";

const IMAGE: ImageContent = {
  type: "image",
  data: "aGVsbG8=", // "hello"
  mimeType: "image/png",
};

const TEXT_MARKER: TextContent = {
  type: "text",
  text: "[image: pic.png (5 bytes)]",
};

function fakeModel(): Model<Api> {
  return {
    id: "vision",
    name: "vision",
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

Deno.test("analyzeContent replaces image blocks with analysis text", async () => {
  const calls: Context[] = [];
  const analyzer = new ImageAnalyzer(
    fakeModel(),
    fakeStreamFn("DESC", {}, (c) => calls.push(c)),
  );

  const out = await analyzer.analyzeContent([TEXT_MARKER, IMAGE]);

  assertEquals(out, [
    TEXT_MARKER,
    { type: "text", text: "[image analysis]\nDESC" },
  ]);
  // The analysis call carried the image and the analysis system prompt.
  assertEquals(calls.length, 1);
  const content = calls[0]!.messages[0]!.content as Array<{
    type: string;
    data?: string;
  }>;
  assertEquals(
    content.some((b) => b.type === "image" && b.data === IMAGE.data),
    true,
  );
  assertEquals(calls[0]!.systemPrompt?.includes("image analysis"), true);
});

Deno.test("analyzeContent caches per image (no re-analysis across turns)", async () => {
  let callCount = 0;
  const analyzer = new ImageAnalyzer(
    fakeModel(),
    fakeStreamFn("DESC", {}, () => callCount++),
  );

  const first = await analyzer.analyzeContent([TEXT_MARKER, IMAGE]);
  const second = await analyzer.analyzeContent([TEXT_MARKER, IMAGE]);

  assertEquals(first, second);
  assertEquals(callCount, 1);
});

Deno.test("analyzeContent falls back to the original content on failure", async () => {
  const analyzer = new ImageAnalyzer(
    fakeModel(),
    fakeStreamFn("", { fail: true }),
  );

  const content = [TEXT_MARKER, IMAGE];
  const out = await analyzer.analyzeContent(content);

  assertEquals(out, content);
});

Deno.test("analyzeContent without images never calls the model", async () => {
  let callCount = 0;
  const analyzer = new ImageAnalyzer(
    fakeModel(),
    fakeStreamFn("DESC", {}, () => callCount++),
  );

  const content: Array<TextContent | ImageContent> = [
    { type: "text", text: "plain" },
  ];
  const out = await analyzer.analyzeContent(content);

  assertEquals(out, content);
  assertEquals(callCount, 0);
});
