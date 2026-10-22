import { assertEquals } from "@std/assert";
import {
  type ContextOverflowNumbers,
  isContextOverflowText,
  parseContextOverflow,
} from "./context-overflow.ts";

/** The wording the failure was reported with (OpenCode Go forwarding
 * Console Go's rejection). Kept verbatim: it is the fixture the whole
 * feature exists for. */
const REPORTED =
  "Upstream request failed: [invalid_request_error] This model's maximum " +
  "context length is 1048576 tokens. However, you requested 1050931 tokens " +
  "(666931 in the messages, 384000 in the completion). Please reduce the " +
  "length of the messages or completion. (request_id: af41405c) (status " +
  "400; url https://opencode.ai/inference/go/openai/v1/chat/completions)";

Deno.test("isContextOverflowText classifies the providers' window rejections", () => {
  assertEquals(isContextOverflowText(REPORTED), true);
  // The other families the transport must recognise before it can shrink a
  // cap: Anthropic, Google, and OpenAI's older chat wording.
  assertEquals(
    isContextOverflowText("prompt is too long: 208310 tokens > 200000 maximum"),
    true,
  );
  assertEquals(
    isContextOverflowText(
      "The input token count (1196265) exceeds the maximum number of tokens " +
        "allowed (1048576).",
    ),
    true,
  );
  assertEquals(
    isContextOverflowText("context_length_exceeded: reduce the length"),
    true,
  );
});

Deno.test("isContextOverflowText leaves other failures alone", () => {
  assertEquals(isContextOverflowText("invalid api key"), false);
  assertEquals(
    isContextOverflowText("Stream ended without finish_reason"),
    false,
  );
  assertEquals(isContextOverflowText("rate_limit_exceeded (429)"), false);
});

Deno.test("parseContextOverflow reads the reported counts", () => {
  type Parsed = ContextOverflowNumbers;
  const expected: Parsed = {
    windowTokens: 1_048_576,
    promptTokens: 666_931,
  };
  assertEquals(parseContextOverflow(REPORTED), expected);
});

Deno.test("parseContextOverflow reads the other providers' counts", () => {
  assertEquals(
    parseContextOverflow("prompt is too long: 208310 tokens > 200000 maximum"),
    { windowTokens: 200_000, promptTokens: 208_310 },
  );
  assertEquals(
    parseContextOverflow(
      "The input token count (1196265) exceeds the maximum number of tokens " +
        "allowed (1048576).",
    ),
    { windowTokens: 1_048_576, promptTokens: 1_196_265 },
  );
  // OpenAI's older chat wording reports the prompt after "in your prompt".
  assertEquals(
    parseContextOverflow(
      "This model's maximum context length is 4096 tokens, however you " +
        "requested 5000 tokens (4096 in your prompt; 904 for the completion).",
    ),
    { windowTokens: 4_096, promptTokens: 4_096 },
  );
});

Deno.test("parseContextOverflow never guesses for text without numbers", () => {
  assertEquals(parseContextOverflow("context_length_exceeded"), {});
  assertEquals(parseContextOverflow("invalid api key"), {});
});
