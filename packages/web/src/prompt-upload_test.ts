import { test } from "bun:test";
import { assertEquals, assertThrows } from "@std/assert";
import { promptBody } from "./api-client.ts";
import { sha256Hex } from "./prompt-upload.ts";
import type { PendingFile } from "./types.ts";

function pending(overrides: Partial<PendingFile> = {}): PendingFile {
  return {
    id: "p1",
    name: "run.log",
    size: 5,
    file: new File(["hello"], "run.log"),
    status: "done",
    uploaded: 5,
    uploadId: "u1",
    ...overrides,
  };
}

test("promptBody names the upload ids instead of carrying bytes", () => {
  const body = promptBody("このログを見て", undefined, undefined, [
    pending(),
    pending({ id: "p2", name: "b.txt", uploadId: "u2" }),
  ]);
  assertEquals(body.uploads, ["u1", "u2"]);
  assertEquals("files" in body, false);
  assertEquals("data" in body, false);
});

test("promptBody refuses a file whose upload did not finish", () => {
  assertThrows(
    () =>
      promptBody("x", undefined, undefined, [pending({ uploadId: undefined })]),
    Error,
  );
  assertThrows(
    () =>
      promptBody("x", undefined, undefined, [pending({ status: "uploading" })]),
    Error,
  );
});

test("sha256Hex hashes one chunk as lowercase hex", async () => {
  assertEquals(
    await sha256Hex(new TextEncoder().encode("hello")),
    "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
  );
});
