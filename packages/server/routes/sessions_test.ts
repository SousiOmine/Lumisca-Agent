import { assert, assertEquals, assertThrows } from "@std/assert";
import { parsePromptBody } from "./sessions.ts";
import { AppError } from "./util.ts";

Deno.test("parsePromptBody passes text-only prompts through", () => {
  assertEquals(parsePromptBody({ text: "hello" }), {
    text: "hello",
    images: undefined,
    files: undefined,
    mode: undefined,
  });
});

Deno.test("parsePromptBody passes goal mode metadata through", () => {
  const { text, mode } = parsePromptBody({
    text: "full goal prompt",
    mode: {
      modeId: "goal",
      optionId: "",
      modeLabel: "ゴールモード",
      shortText: "全テストを通す",
    },
  });
  assertEquals(text, "full goal prompt");
  assertEquals(mode, {
    modeId: "goal",
    optionId: "",
    modeLabel: "ゴールモード",
    shortText: "全テストを通す",
  });
});

Deno.test("parsePromptBody converts data-URL images to content blocks", () => {
  const { text, images } = parsePromptBody({
    text: "what is this?",
    images: [
      { data: "aGVsbG8=", mimeType: "image/png" },
      { data: "d29ybGQ=", mimeType: "image/jpeg" },
    ],
  });
  assertEquals(text, "what is this?");
  assertEquals(images, [
    { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
    { type: "image", data: "d29ybGQ=", mimeType: "image/jpeg" },
  ]);
});

Deno.test("parsePromptBody treats an empty image array as no images", () => {
  const { images } = parsePromptBody({ text: "hi", images: [] });
  assertEquals(images, undefined);
});

Deno.test("parsePromptBody allows image-only prompts (empty text)", () => {
  const { text, images } = parsePromptBody({
    text: "",
    images: [{ data: "aGk=", mimeType: "image/png" }],
  });
  assertEquals(text, "");
  assertEquals(images?.length, 1);
  // An omitted `text` field also works when images are attached.
  const noText = parsePromptBody({
    images: [{ data: "aGk=", mimeType: "image/png" }],
  });
  assertEquals(noText.text, "");
});

Deno.test("parsePromptBody rejects invalid bodies", () => {
  const expect400 = (body: unknown, fragment: string) => {
    const thrown = assertThrows(() =>
      parsePromptBody(body as { text?: unknown; images?: unknown })
    );
    assert(thrown instanceof AppError, "must be an AppError");
    const error = thrown as AppError;
    assertEquals(error.status, 400);
    assert(
      error.message.includes(fragment),
      `message should mention "${fragment}": ${error.message}`,
    );
  };

  expect400({}, "text");
  expect400({ text: "" }, "text");
  expect400({ text: 42 }, "text");
  expect400({ text: "hi", images: "not-an-array" }, "images");
  expect400(
    {
      text: "hi",
      images: Array.from({ length: 9 }, () => ({
        data: "x",
        mimeType: "image/png",
      })),
    },
    "8",
  );
  expect400(
    { text: "hi", images: [{ data: "x", mimeType: "text/plain" }] },
    "image/*",
  );
  expect400(
    { text: "hi", images: [{ data: 42, mimeType: "image/png" }] },
    "data",
  );
  expect400(
    {
      text: "hi",
      images: [{ data: "x".repeat(21 * 1024 * 1024), mimeType: "image/png" }],
    },
    "size limit",
  );
});

Deno.test("parsePromptBody decodes attached files", () => {
  const { text, files } = parsePromptBody({
    text: "このログを見て",
    files: [{ name: "run.log", data: "aGVsbG8=" }],
  });
  assertEquals(text, "このログを見て");
  assertEquals(files?.length, 1);
  assertEquals(files?.[0]?.name, "run.log");
  assertEquals(new TextDecoder().decode(files?.[0]?.bytes), "hello");
});

Deno.test("parsePromptBody: a file alone is a prompt", () => {
  const { text, files } = parsePromptBody({
    files: [{ name: "shot.png", data: "aGVsbG8=" }],
  });
  assertEquals(text, "");
  assertEquals(files?.length, 1);
});

Deno.test("parsePromptBody: a data-URL header is accepted and stripped", () => {
  const { files } = parsePromptBody({
    text: "x",
    files: [{ name: "a.txt", data: "data:text/plain;base64,aGVsbG8=" }],
  });
  assertEquals(new TextDecoder().decode(files?.[0]?.bytes), "hello");
});

Deno.test("parsePromptBody: a malformed file is a 400, not a crash", () => {
  assertThrows(
    () => parsePromptBody({ text: "x", files: [{ name: "a.txt" }] }),
    AppError,
  );
  assertThrows(
    () => parsePromptBody({ text: "x", files: [{ data: "aGVsbG8=" }] }),
    AppError,
  );
});
