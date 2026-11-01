/**
 * The conversation's prompt takes the same attachments code mode's prompt
 * does. This is a regression test for a real gap: the route used to read
 * `text` alone, so a picture dropped into a stella conversation reached the
 * server and was dropped there — the UI showed the thumbnail, the model never
 * saw it.
 */
import { assertEquals } from "@std/assert";
import type { ImageContent } from "@lumisca/core";
import { stellaRoutes } from "./stella.ts";
import type { StellaApi } from "./stella.ts";

/** The slice of the core the prompt route touches, recording what it gets. */
function fakeCore(received: {
  texts: string[];
  images: (ImageContent[] | undefined)[];
}): StellaApi {
  return {
    getStellaAgent: () => ({
      id: "a1",
      name: "Aide",
      role: "",
      identity: "",
      icon: "",
      createdAt: 0,
      updatedAt: 0,
    }),
    findStellaSession: () => ({
      id: "s1",
      workspaceId: "w1",
      name: "Aide",
      modelProvider: "faux",
      modelId: "faux-1",
      thinkingLevel: "off",
      stella: true,
      agentId: "a1",
      createdAt: 0,
      updatedAt: 0,
    }),
    startPrompt: (
      _sessionId: string,
      text: string,
      images?: ImageContent[],
    ) => {
      received.texts.push(text);
      received.images.push(images);
    },
  } as unknown as StellaApi;
}

Deno.test("stella prompt: the images travel to the session as content blocks", async () => {
  const received = {
    texts: [] as string[],
    images: [] as (ImageContent[] | undefined)[],
  };
  const app = stellaRoutes(fakeCore(received));
  const response = await app.request("/stella/conversations/a1/prompt", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      text: "これを見て",
      images: [{ data: "aGVsbG8=", mimeType: "image/png" }],
    }),
  });
  assertEquals(response.status, 200);
  assertEquals(received.texts, ["これを見て"]);
  assertEquals(received.images, [
    [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
  ]);
});

Deno.test("stella prompt: an image with no text is a prompt", async () => {
  const received = {
    texts: [] as string[],
    images: [] as (ImageContent[] | undefined)[],
  };
  const app = stellaRoutes(fakeCore(received));
  const response = await app.request("/stella/conversations/a1/prompt", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      text: "",
      images: [{ data: "aGVsbG8=", mimeType: "image/png" }],
    }),
  });
  assertEquals(response.status, 200);
  assertEquals(received.texts, [""]);
  assertEquals(received.images.length, 1);
});

Deno.test("stella prompt: text alone still arrives as before", async () => {
  const received = {
    texts: [] as string[],
    images: [] as (ImageContent[] | undefined)[],
  };
  const app = stellaRoutes(fakeCore(received));
  const response = await app.request("/stella/conversations/a1/prompt", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "こんにちは" }),
  });
  assertEquals(response.status, 200);
  assertEquals(received.texts, ["こんにちは"]);
  assertEquals(received.images, [undefined]);
});
