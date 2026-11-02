import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "node:path";
import { type ChatMessage, MAX_ATTACHMENTS_PER_CALL } from "../shared/mod.ts";
import { SessionAttachmentStore } from "../session/attachments.ts";
import { Sandbox } from "../workspace/sandbox.ts";
import { HostFileBackend } from "./host/files.ts";
import type { ToolResult } from "./schema.ts";
import { createSendChatTool } from "./send-chat.ts";

/** A `send_chat` tool over a temp workspace: `root` is the folder paths
 * resolve in, `storeRoot` where the bytes are kept. */
async function fixture(
  files: Record<string, string | Uint8Array> = {},
): Promise<{
  root: string;
  tool: ReturnType<typeof createSendChatTool>;
  store: SessionAttachmentStore;
  storeRoot: string;
  /** A path inside the workspace (what the model would name). */
  at: (name: string) => string;
  cleanup: () => Promise<void>;
}> {
  const root = await Deno.makeTempDir({ prefix: "lumisca-send-chat-" });
  const storeRoot = await Deno.makeTempDir({
    prefix: "lumisca-send-chat-store-",
  });
  const backend = new HostFileBackend(new Sandbox([root]));
  const store = new SessionAttachmentStore(storeRoot);
  for (const [path, data] of Object.entries(files)) {
    if (typeof data === "string") {
      await Deno.writeTextFile(join(root, path), data);
    } else {
      await Deno.writeFile(join(root, path), data);
    }
  }
  return {
    root,
    tool: createSendChatTool({ files: backend, store, sessionId: "s1" }),
    store,
    storeRoot,
    at: (name) => join(root, name),
    cleanup: async () => {
      await Deno.remove(root, { recursive: true });
      await Deno.remove(storeRoot, { recursive: true });
    },
  };
}

/** The message a call sent (the tool's `details`). */
function sent(result: ToolResult): ChatMessage {
  return result.details as unknown as ChatMessage;
}

/** The text of a tool result (what the model reads back). */
function receipt(result: ToolResult): string {
  return result.content
    .map((block) => block.type === "text" ? block.text : "")
    .join("");
}

Deno.test("send_chat: the words are the message", async () => {
  const test = await fixture();
  try {
    const result = await test.tool.execute("t", { text: "終わりました。" });
    assertEquals(sent(result), {
      text: "終わりました。",
      card: null,
      attachments: [],
    });
    // What the MODEL reads back is a receipt, not the message: the words are
    // already in the transcript as this call's arguments.
    const reply = receipt(result);
    assert(reply.includes("Sent"), reply);
    assertEquals(reply.includes("終わりました。"), false, reply);
  } finally {
    await test.cleanup();
  }
});

Deno.test("send_chat: a card is validated and travels with the message", async () => {
  const test = await fixture();
  try {
    const card = '<Card title="確認"><Text>進めますか。</Text></Card>';
    const result = await test.tool.execute("t", {
      text: "確認します。",
      card,
    });
    assertEquals(sent(result), {
      text: "確認します。",
      card,
      attachments: [],
    });

    // A card alone is a message too.
    const onlyCard = await test.tool.execute("t", { card });
    assertEquals(sent(onlyCard), { text: "", card, attachments: [] });
  } finally {
    await test.cleanup();
  }
});

Deno.test("send_chat: a card the server cannot read fails the call", async () => {
  const test = await fixture();
  try {
    // The parse is the same one the browser runs, so a markup that passes
    // here always draws: half a card would be half a message.
    const error = await assertRejects(() =>
      test.tool.execute("t", { card: "<Card><Unknown>x</Unknown></Card>" })
    );
    assert(String(error).includes("Invalid card markup"), String(error));
    // An empty card is refused before that: nothing would be sent.
    await assertRejects(() => test.tool.execute("t", { card: "   " }));
  } finally {
    await test.cleanup();
  }
});

Deno.test("send_chat: files are sent with the message", async () => {
  const test = await fixture({
    "chart.png": new Uint8Array([1, 2, 3, 4]),
    "report.md": "# notes\n",
  });
  try {
    const result = await test.tool.execute("t", {
      text: "2つ送ります。",
      paths: [test.at("chart.png"), test.at("report.md")],
    });
    const message = sent(result);
    assertEquals(message.text, "2つ送ります。");
    assertEquals(message.card, null);
    assertEquals(message.attachments.length, 2);

    // The image is inline and keeps the user's name; the report is a
    // download. The store generates the name the route serves.
    const [image, report] = message.attachments;
    assertEquals(image?.displayName, "chart.png");
    assertEquals(image?.inline, true);
    assertEquals(image?.size, 4);
    assertEquals(report?.displayName, "report.md");
    assertEquals(report?.inline, false);

    // The bytes really are in the store (the card links this name).
    const resolved = await test.store.resolve("s1", image!.name);
    assert(resolved !== undefined, "the attachment was not stored");
    assertEquals(resolved.downloadName, "chart.png");
  } finally {
    await test.cleanup();
  }
});

Deno.test("send_chat: a call that sends nothing is refused", async () => {
  const test = await fixture();
  try {
    // An empty message would be an empty row on the screen, so the tool
    // refuses it instead of hiding it later.
    await assertRejects(() => test.tool.execute("t", {}));
    await assertRejects(() => test.tool.execute("t", { text: "   " }));
    await assertRejects(() => test.tool.execute("t", { paths: [] }));
  } finally {
    await test.cleanup();
  }
});

Deno.test("send_chat: a missing file fails the whole call", async () => {
  const test = await fixture({ "ok.txt": "hi" });
  try {
    // Half a message is worse than a failed one: the user would look for a
    // file the agent thought it had sent.
    await assertRejects(() =>
      test.tool.execute("t", {
        text: "送ります。",
        paths: [test.at("ok.txt"), test.at("missing.txt")],
      })
    );
  } finally {
    await test.cleanup();
  }
});

Deno.test("send_chat: too many files in one call is refused", async () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < MAX_ATTACHMENTS_PER_CALL + 1; i++) {
    files[`f${i}.txt`] = `file ${i}`;
  }
  const test = await fixture(files);
  try {
    const error = await assertRejects(() =>
      test.tool.execute("t", {
        text: "たくさん。",
        paths: Object.keys(files).map((name) => test.at(name)),
      })
    );
    assert(String(error).includes("up to"), String(error));
  } finally {
    await test.cleanup();
  }
});
