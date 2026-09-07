import { assertEquals, assertThrows } from "@std/assert";
import { sessionHeadersFor } from "./lang-model.ts";
import { opencodeGoProvider } from "../models/dev-catalog.ts";
import type { Api, Model } from "./types.ts";

/** A plain first-party OpenAI model (no session affinity). */
const openaiModel: Model<Api> = {
  id: "gpt-test",
  name: "gpt-test",
  api: "openai-completions",
  provider: "openai",
};

Deno.test(
  "sessionHeadersFor sends the conversation id as x-opencode-session for OpenCode Go",
  () => {
    // The model comes from the real models.dev catalog so the test also
    // pins the transport's provider-id constant against catalog renames.
    const model = opencodeGoProvider().getModels()[0]!;
    assertEquals(
      sessionHeadersFor(model, { sessionId: "conv-1" }),
      { "x-opencode-session": "conv-1" },
    );
  },
);

Deno.test("sessionHeadersFor is a no-op for providers without session affinity", () => {
  assertEquals(
    sessionHeadersFor(openaiModel, { sessionId: "conv-1" }),
    undefined,
  );
  assertEquals(sessionHeadersFor(openaiModel), undefined);
});

Deno.test("sessionHeadersFor fails fast when an OpenCode Go request has no conversation id", () => {
  const model = opencodeGoProvider().getModels()[0]!;
  assertThrows(
    () => sessionHeadersFor(model),
    Error,
    "x-opencode-session",
  );
  assertThrows(
    () => sessionHeadersFor(model, { sessionId: "" }),
    Error,
    "x-opencode-session",
  );
});
