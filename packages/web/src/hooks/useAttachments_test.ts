import { assertEquals } from "@std/assert";
import { canAttach } from "./useAttachments.ts";

Deno.test("canAttach: a picture rides in the message, so every mode takes one", () => {
  assertEquals(canAttach({ type: "image/png" }, false), true);
  assertEquals(canAttach({ type: "image/jpeg" }, true), true);
});

Deno.test("canAttach: any other file needs a machine to be written into", () => {
  assertEquals(canAttach({ type: "text/plain" }, true), true);
  assertEquals(canAttach({ type: "application/pdf" }, true), true);
  // code mode: the tools work on the user's own folders, so there is nowhere
  // for the upload to go (core's savePromptUploads refuses the session).
  assertEquals(canAttach({ type: "text/plain" }, false), false);
  // The OS could not name the type: not a picture, so it needs the machine.
  assertEquals(canAttach({ type: "" }, false), false);
});
