import { test } from "bun:test";
import type { PromptFileRef } from "@lumisca/core";
/**
 * The conversation's prompt takes the same attachments code mode's prompt
 * does, and puts them where the agent can reach them.
 *
 * The shape this pins: a prompt's pictures and files travel ONE way — written
 * into the machine and recorded as references on the message — rather than as
 * byte blocks in the message. A picture kept as a block would sit in the
 * database for the life of the conversation, and a conversation lives for
 * years (see ai/types.ts UserMessage.files).
 */
import { assertEquals } from "@std/assert";
import type { StellaApi } from "../contracts/stella.ts";
import type { PromptUploadSink } from "./prompt-uploads.ts";
import { stellaRoutes } from "./stella.ts";
import { stellaApiStub } from "./test-stubs.ts";
import { jsonError } from "./util.ts";

interface Received {
  texts: string[];
  images: unknown[];
  uploads: { name: string; bytes: Uint8Array }[][];
  saved: PromptFileRef[];
  /** What the route asked for, in order: the machine, the uploads, the run. */
  order: string[];
}

/** The slice of the core the prompt route touches, recording what it gets. */
function fakeCore(received: Received): StellaApi {
  return stellaApiStub({
    getStellaAgent: () => ({
      id: "a1",
      name: "Aide",
      role: "",
      identity: "",
      icon: "",
      model: null,
      onboardedAt: null,
      disabledAt: null,
      createdAt: 0,
      updatedAt: 0,
    }),
    findStellaSession: () => ({
      id: "s1",
      mainAgentId: "a1",
      workspaceId: "w1",
      name: "Aide",
      modelProvider: "faux",
      modelId: "faux-1",
      thinkingLevel: "off",
      stella: true,
      personaId: "a1",
      createdAt: 0,
      updatedAt: 0,
    }),
    // Sending asks first: a conversation that is already open never passes
    // through the open endpoint again, so nothing else would notice a machine
    // that stopped since.
    ensureStellaReady: () => {
      received.order.push("ready");
      return Promise.resolve();
    },
    // The catalog is read after the wake: a sleeping machine is not read, so
    // a run that woke one would start without its skills.
    ensureStellaSkills: () => {
      received.order.push("skills");
      return Promise.resolve();
    },
    savePromptImages: (
      _sessionId: string,
      uploads: readonly { name: string; bytes: Uint8Array }[],
    ) => {
      received.order.push("upload");
      received.uploads.push(
        uploads.map((file) => ({
          name: file.name,
          bytes: file.bytes,
        })),
      );
      received.saved = uploads.map((file, index) => ({
        name: file.name,
        path: `/home/agent/agents/a1/uploads/1-ab/0${index}-${file.name}`,
        size: file.bytes.length,
        ref: `uploads/1-ab/0${index}-${file.name}`,
        image: true,
      }));
      return Promise.resolve(received.saved);
    },
    startPrompt: (
      _sessionId: string,
      text: string,
      images?: unknown,
      _mode?: unknown,
      files?: PromptFileRef[],
    ) => {
      received.order.push("prompt");
      received.texts.push(text);
      received.images.push(images);
      if (files !== undefined) received.saved = files;
    },
  });
}

function setup(uploads?: PromptUploadSink): {
  app: ReturnType<typeof stellaRoutes>;
  received: Received;
} {
  const received: Received = {
    texts: [],
    images: [],
    uploads: [],
    saved: [],
    order: [],
  };
  const app =
    uploads === undefined
      ? stellaRoutes(fakeCore(received))
      : stellaRoutes(fakeCore(received), uploads);
  // The same error table the app mounts (app.ts's onError): a route mounted
  // on its own would answer Hono's default 500 for an AppError.
  app.onError((error, c) => jsonError(c, error));
  return { app, received };
}
test("stella prompt: a picture is written into the machine, not the message", async () => {
  const { app, received } = setup();
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
  // No content blocks on the message: the prompt carries references.
  assertEquals(received.images, [undefined]);
  assertEquals(received.uploads.length, 1);
  assertEquals(received.uploads[0]![0]!.name, "image-1.png");
  assertEquals(received.saved[0]!.ref, "uploads/1-ab/00-image-1.png");
});

test("stella prompt: the machine is made ready before the run", async () => {
  // The machine is stopped or crashes while the conversation is open, and
  // nothing else on this path would start it again (see ARCHITECTURE.md):
  // every tool would answer podman's "container state improper". The uploads
  // are written inside the machine too, so the order is ready → upload →
  // prompt.
  const { app, received } = setup();
  const response = await app.request("/stella/conversations/a1/prompt", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      text: "これを見て",
      images: [{ data: "aGVsbG8=", mimeType: "image/png" }],
    }),
  });
  assertEquals(response.status, 200);
  assertEquals(received.order, ["ready", "skills", "upload", "prompt"]);
});

test("stella prompt: an image with no text is a prompt", async () => {
  const { app, received } = setup();
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
  assertEquals(received.uploads.length, 1);
});

test("stella prompt: an unsupported picture type is refused by name", async () => {
  const { app } = setup();
  // A prompt's pictures are drawn back by their extension, so the type has to
  // be one the conversation can show. Refusing here says which one it was
  // instead of storing a file the UI cannot draw.
  const response = await app.request("/stella/conversations/a1/prompt", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      text: "これを見て",
      images: [{ data: "aGVsbG8=", mimeType: "image/tiff" }],
    }),
  });
  assertEquals(response.status, 400);
});

test("stella prompt: uploaded files are resolved to their machine paths", async () => {
  const released: string[][] = [];
  const { app, received } = setup({
    resolve: (_agentId, ids) =>
      ids.map((id) => ({
        name: `${id}.log`,
        path: `/home/agent/agents/a1/uploads/2-cd/01-${id}.log`,
        size: 10,
        ref: `uploads/2-cd/01-${id}.log`,
        image: false,
      })),
    release: (ids) => released.push([...ids]),
  });
  const response = await app.request("/stella/conversations/a1/prompt", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "このログを見て", uploads: ["u1"] }),
  });
  assertEquals(response.status, 200);
  assertEquals(
    received.saved.map((file) => file.ref),
    ["uploads/2-cd/01-u1.log"],
  );
  // No picture took the byte path: the file was already in the machine.
  assertEquals(received.uploads, []);
  assertEquals(released, [["u1"]]);
  assertEquals(received.order, ["ready", "skills", "prompt"]);
});

test("stella prompt: an upload id without a store is a 409", async () => {
  const { app } = setup();
  const response = await app.request("/stella/conversations/a1/prompt", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "x", uploads: ["u1"] }),
  });
  assertEquals(response.status, 409);
});

test("stella prompt: text alone needs no upload", async () => {
  const { app, received } = setup();
  const response = await app.request("/stella/conversations/a1/prompt", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "こんにちは" }),
  });
  assertEquals(response.status, 200);
  assertEquals(received.texts, ["こんにちは"]);
  assertEquals(received.images, [undefined]);
  assertEquals(received.uploads, []);
});

test("stella prompt: the file notice is for the model, not the screen", async () => {
  // The route hands the core the user's own words: the notice naming the
  // files is added to the message's modelContent (see session-agent's
  // buildUserMessage), so the conversation draws the sentence the user wrote
  // instead of a paragraph addressed to the model.
  const { app, received } = setup({
    resolve: () => [
      {
        name: "run.log",
        path: "/home/agent/agents/a1/uploads/1-ab/01-run.log",
        size: 5,
        ref: "uploads/1-ab/01-run.log",
        image: false,
      },
    ],
    release: () => {},
  });
  const response = await app.request("/stella/conversations/a1/prompt", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "このログを見て", uploads: ["u1"] }),
  });
  assertEquals(response.status, 200);
  assertEquals(received.texts, ["このログを見て"]);
  assertEquals(received.saved.length, 1);
  assertEquals(received.saved[0]!.name, "run.log");
});
