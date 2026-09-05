import { assert, assertEquals, assertThrows } from "@std/assert";
import { parsePromptBody } from "./sessions.ts";
import { AppError } from "./util.ts";

Deno.test("parsePromptBody passes text-only prompts through", () => {
  assertEquals(parsePromptBody({ text: "hello" }), {
    text: "hello",
    images: undefined,
    mode: undefined,
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
