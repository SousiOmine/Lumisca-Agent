/**
 * What a stella prompt sends. The regression this pins: the conversation's
 * prompt used to carry `{ text }` alone, so a picture the composer held never
 * left the browser — a drop or a paste worked in code mode and silently did
 * nothing here.
 */
import { assertEquals } from "@std/assert";
import { record } from "./api-test-utils.ts";

globalThis.__LUMISCA_TOKEN__ = "test-token";
const { stellaApi } = await import("./api-stella.ts");

function dataUrl(base64: string, mimeType: string): string {
  return `data:${mimeType};base64,${base64}`;
}

/** The JSON body of a recorded request (asserted to exist, so a missing body
 * fails as "no body" rather than as a parse error). */
function bodyOf(sent: { body?: string }): unknown {
  assertEquals(sent.body !== undefined, true, "the call must send a body");
  return JSON.parse(sent.body!);
}

Deno.test("stella prompt: text alone sends only the text", async () => {
  const sent = await record(() => stellaApi.prompt("a1", "こんにちは"));
  assertEquals(sent.method, "POST");
  assertEquals(sent.path, "/api/stella/conversations/a1/prompt");
  assertEquals(bodyOf(sent), { text: "こんにちは" });
});

Deno.test("stella prompt: attached images travel as base64 blocks", async () => {
  const sent = await record(() =>
    stellaApi.prompt("a1", "見て", [
      {
        data: dataUrl("aGVsbG8=", "image/png"),
        mimeType: "image/png",
        name: "shot.png",
      },
    ])
  );
  // The body is the shared prompt body: the data-URL header is stripped, so
  // the server receives the same shape code mode sends.
  assertEquals(bodyOf(sent), {
    text: "見て",
    images: [{ data: "aGVsbG8=", mimeType: "image/png" }],
  });
});

Deno.test("stella prompt: an image with no text is still a body", async () => {
  const sent = await record(() =>
    stellaApi.prompt("a1", "", [
      { data: dataUrl("aGVsbG8=", "image/png"), mimeType: "image/png" },
    ])
  );
  assertEquals(bodyOf(sent), {
    text: "",
    images: [{ data: "aGVsbG8=", mimeType: "image/png" }],
  });
});

Deno.test("stella prompt: the token rides every request", async () => {
  const sent = await record(() => stellaApi.prompt("a1", "x"));
  assertEquals(sent.headers.get("x-lumisca-token"), "test-token");
});
