import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "node:path";
import { SessionAttachmentStore } from "../session/attachments.ts";
import { Sandbox } from "../workspace/sandbox.ts";
import { createChatAttachTool } from "./attach.ts";
import { HostFileBackend } from "./host/files.ts";
import type { ToolResult } from "./schema.ts";

/** A tool over a temp workspace: `root` is the folder paths resolve in. */
async function fixture(
  files: Record<string, string | Uint8Array> = {},
): Promise<{
  root: string;
  tool: ReturnType<typeof createChatAttachTool>;
  store: SessionAttachmentStore;
  storeRoot: string;
  write: (path: string, data: string) => Promise<void>;
  cleanup: () => Promise<void>;
}> {
  const root = await Deno.makeTempDir({ prefix: "lumisca-attach-" });
  const storeRoot = await Deno.makeTempDir({ prefix: "lumisca-attach-store-" });
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
    tool: createChatAttachTool({ files: backend, store, sessionId: "s1" }),
    store,
    storeRoot,
    write: (path, data) =>
      Deno.writeTextFile(path.startsWith(root) ? path : join(root, path), data),
    cleanup: async () => {
      await Deno.remove(root, { recursive: true });
      await Deno.remove(storeRoot, { recursive: true });
    },
  };
}

function details(result: ToolResult): {
  attachments: Array<{
    name: string;
    displayName: string;
    size: number;
    inline: boolean;
  }>;
} {
  return result.details as {
    attachments: Array<{
      name: string;
      displayName: string;
      size: number;
      inline: boolean;
    }>;
  };
}

Deno.test("chat_attach: an image is inline, other files are downloads", async () => {
  const test = await fixture({
    "chart.png": new Uint8Array([1, 2, 3, 4]),
    "report.md": "# notes\n",
  });
  try {
    const result = await test.tool.execute("t", {
      paths: [join(test.root, "chart.png"), join(test.root, "report.md")],
    }, undefined);
    const attachments = details(result).attachments;
    assertEquals(attachments.length, 2);
    // The extension decides how the card and the route treat the file.
    assertEquals(attachments[0]!.name.endsWith(".png"), true);
    assertEquals(attachments[0]!.inline, true);
    assertEquals(attachments[0]!.displayName, "chart.png");
    assertEquals(attachments[0]!.size, 4);
    assertEquals(attachments[1]!.name.endsWith(".md"), true);
    assertEquals(attachments[1]!.inline, false);
    // The bytes were copied: the original is no longer needed.
    const stored = await test.store.resolve("s1", attachments[0]!.name);
    assert(stored !== undefined);
    assertEquals(stored.mimeType, "image/png");
  } finally {
    await test.cleanup();
  }
});

Deno.test("chat_attach: the download keeps the file's own name", async () => {
  const test = await fixture();
  try {
    await test.write("summary of the run.txt", "done\n");
    const result = await test.tool.execute(
      "t",
      { paths: [join(test.root, "summary of the run.txt")] },
      undefined,
    );
    const attachment = details(result).attachments[0]!;
    assertEquals(attachment.displayName, "summary of the run.txt");
    const stored = await test.store.resolve("s1", attachment.name);
    assert(stored !== undefined);
    assertEquals(stored.downloadName, "summary of the run.txt");
    assertEquals(stored.mimeType, "text/plain; charset=utf-8");
  } finally {
    await test.cleanup();
  }
});

Deno.test("chat_attach: SVG is a download, never an inline document", async () => {
  const test = await fixture();
  try {
    await test.write("diagram.svg", "<svg/>");
    const result = await test.tool.execute(
      "t",
      { paths: [join(test.root, "diagram.svg")] },
      undefined,
    );
    const attachment = details(result).attachments[0]!;
    // An inline SVG could carry script; as a download it is just a file.
    assertEquals(attachment.inline, false);
    const stored = await test.store.resolve("s1", attachment.name);
    assertEquals(stored?.mimeType, "application/octet-stream");
  } finally {
    await test.cleanup();
  }
});

Deno.test("chat_attach: a missing file or a directory fails", async () => {
  const test = await fixture({ "here.txt": "x" });
  try {
    await assertRejects(
      () =>
        test.tool.execute(
          "t",
          { paths: [join(test.root, "missing.txt")] },
          undefined,
        ),
      Error,
      "does not exist",
    );
    await Deno.mkdir(join(test.root, "folder"));
    await assertRejects(
      () =>
        test.tool.execute(
          "t",
          { paths: [join(test.root, "folder")] },
          undefined,
        ),
      Error,
      "Is a directory",
    );
  } finally {
    await test.cleanup();
  }
});

Deno.test("chat_attach: no paths is refused", async () => {
  const test = await fixture();
  try {
    await assertRejects(
      () => test.tool.execute("t", {}, undefined),
      Error,
      "Attach at least one file",
    );
  } finally {
    await test.cleanup();
  }
});

Deno.test("chat_attach: too many files in one call is refused", async () => {
  const test = await fixture();
  try {
    const paths = Array.from(
      { length: 11 },
      (_, i) => join(test.root, `f${i}.txt`),
    );
    for (const path of paths) await test.write(path, "x");
    await assertRejects(
      () => test.tool.execute("t", { paths }, undefined),
      Error,
      "up to 10 files",
    );
  } finally {
    await test.cleanup();
  }
});
