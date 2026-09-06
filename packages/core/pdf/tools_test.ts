import { basename, join } from "node:path";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { Sandbox } from "../workspace/sandbox.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { createToolSearchTool } from "../tools/search-tool.ts";
import { createToolCallTool } from "../tools/call-tool.ts";
import { createChatTools, createCodingTools } from "../tools/mod.ts";
import type { Workspace } from "../types/workspace.ts";
import { TOOL_PDF_READ_PAGES } from "../shared/mod.ts";
import {
  createPdfTools,
  DEFAULT_PDF_DPI,
  MAX_PDF_PAGES_PER_CALL,
  PDF_TOOL_NAMES,
  type PdfRenderer,
} from "./tools.ts";
import {
  makeRealTempDir,
  MINI_PNG,
  removeDirRetry,
  toolText,
} from "../test-utils.ts";

/** Fake renderer: serves canned PNGs, mirroring the production range
 * validation (1-based pages within the total). */
function fakeRenderer(totalPages: number): PdfRenderer {
  return {
    render: (_pdfPath, requested, _dpi) => {
      const bad = requested.filter((p) => p < 1 || p > totalPages);
      if (bad.length > 0) {
        return Promise.reject(
          new Error(
            `Page ${
              bad.join(",")
            } out of range: the PDF has ${totalPages} page(s)`,
          ),
        );
      }
      return Promise.resolve({
        totalPages,
        pages: requested.map((page) => ({
          page,
          png: MINI_PNG,
          width: 10,
          height: 20,
        })),
      });
    },
  };
}

async function fixture(): Promise<{ root: string; folder: string }> {
  const root = await makeRealTempDir("lumisca-pdf-");
  await Deno.writeFile(join(root, "doc.pdf"), new Uint8Array([1, 2, 3]));
  return { root, folder: basename(root) };
}

function makeTool(root: string, totalPages = 2) {
  const tools = createPdfTools({
    sandbox: new Sandbox([root]),
    renderer: fakeRenderer(totalPages),
  });
  return tools[0]!;
}

Deno.test("pdf tool is named pdf_read_pages and listed in PDF_TOOL_NAMES", () => {
  assertEquals(PDF_TOOL_NAMES, [TOOL_PDF_READ_PAGES]);
  const tools = createPdfTools({ sandbox: new Sandbox([]) });
  assertEquals(tools.length, 1);
  assertEquals(tools[0]!.name, TOOL_PDF_READ_PAGES);
});

Deno.test("pdf tool renders requested pages as image blocks", async () => {
  const { root, folder } = await fixture();
  try {
    const result = await makeTool(root).execute("id", {
      path: `${folder}/doc.pdf`,
      pages: [1, 2],
    });
    const text = toolText(result);
    assert(
      text.includes(`pages 1, 2 of 2 at ${DEFAULT_PDF_DPI}dpi`),
      `summary missing: ${text}`,
    );
    const images = result.content.filter((c) => c.type === "image");
    assertEquals(images.length, 2);
    assertEquals(images[0]?.mimeType, "image/png");
    for (const image of images) {
      if (image.type !== "image") continue;
      const decoded = Uint8Array.from(
        atob(image.data),
        (c) => c.charCodeAt(0),
      );
      assertEquals(decoded, MINI_PNG);
    }
    assertEquals(result.details, {
      path: join(root, "doc.pdf"),
      pages: [1, 2],
      totalPages: 2,
      dpi: DEFAULT_PDF_DPI,
    });
  } finally {
    await removeDirRetry(root);
  }
});

Deno.test("pdf tool dedupes duplicate pages keeping the requested order", async () => {
  const { root, folder } = await fixture();
  try {
    const result = await makeTool(root, 3).execute("id", {
      path: `${folder}/doc.pdf`,
      pages: [2, 1, 2],
    });
    assertEquals(result.details["pages"], [2, 1]);
    assertEquals(result.content.filter((c) => c.type === "image").length, 2);
  } finally {
    await removeDirRetry(root);
  }
});

Deno.test("pdf tool rejects invalid pages and dpi", async () => {
  const { root, folder } = await fixture();
  try {
    const tool = makeTool(root);
    const path = `${folder}/doc.pdf`;
    await assertRejects(
      () => tool.execute("id", { path, pages: [] }),
      Error,
      "must not be empty",
    );
    for (const pages of [[0], [-1], [1.5]]) {
      await assertRejects(
        () => tool.execute("id", { path, pages }),
        Error,
        "1-based",
        `expected rejection for pages=${JSON.stringify(pages)}`,
      );
    }
    await assertRejects(
      () =>
        tool.execute("id", {
          path,
          pages: Array.from(
            { length: MAX_PDF_PAGES_PER_CALL + 1 },
            (_, i) => i + 1,
          ),
        }),
      Error,
      `At most ${MAX_PDF_PAGES_PER_CALL} pages`,
    );
    for (const dpi of [71, 301]) {
      await assertRejects(
        () => tool.execute("id", { path, pages: [1], dpi }),
        Error,
        "dpi must be",
        `expected rejection for dpi=${dpi}`,
      );
    }
  } finally {
    await removeDirRetry(root);
  }
});

Deno.test("pdf tool surfaces out-of-range pages", async () => {
  const { root, folder } = await fixture();
  try {
    const error = await makeTool(root, 2).execute("id", {
      path: `${folder}/doc.pdf`,
      pages: [5],
    }).then(
      () => null,
      (e: unknown) => e instanceof Error ? e : new Error(String(e)),
    );
    assert(error !== null, "expected an out-of-range error");
    assert(error.message.includes("out of range"), error.message);
  } finally {
    await removeDirRetry(root);
  }
});

Deno.test("pdf tool stays inside the workspace sandbox", async () => {
  const { root, folder } = await fixture();
  try {
    const tool = makeTool(root);
    await assertRejects(
      () => tool.execute("id", { path: `Elsewhere/doc.pdf`, pages: [1] }),
      Error,
      "Unknown workspace folder",
    );
    await assertRejects(
      () => tool.execute("id", { path: folder, pages: [1] }),
      Error,
      "Is a directory",
    );
  } finally {
    await removeDirRetry(root);
  }
});

Deno.test("preloaded tool sets never contain the pdf tool", async () => {
  const root = await makeRealTempDir("lumisca-pdf-tools-");
  try {
    const workspace: Workspace = {
      id: "w1",
      name: "ws",
      folders: [root],
      createdAt: 0,
      chat: false,
    };
    // Preloaded definitions stay small: the pdf tool is discoverable
    // through the session's tool registry via tool_search, exactly like
    // MCP and browser-lab tools.
    for (
      const tools of [
        createCodingTools(workspace, {}),
        createCodingTools(workspace),
        createChatTools({}),
      ]
    ) {
      assertEquals(
        tools.some((t) => t.name === TOOL_PDF_READ_PAGES),
        false,
        "the preloaded tool set must not contain the pdf tool",
      );
    }
  } finally {
    await removeDirRetry(root);
  }
});

Deno.test("pdf tool is discoverable via tool_search and callable via tool_call", async () => {
  const { root, folder } = await fixture();
  try {
    const registry = new ToolRegistry();
    registry.addTools(
      createPdfTools({
        sandbox: new Sandbox([root]),
        renderer: fakeRenderer(2),
      }),
    );
    const search = createToolSearchTool(() => registry);
    const found = toolText(
      await search.execute("search", { query: "pdf" }),
    );
    assert(found.includes(TOOL_PDF_READ_PAGES), `not found: ${found}`);

    const call = createToolCallTool(() => registry);
    const result = await call.execute("call", {
      name: TOOL_PDF_READ_PAGES,
      args: { path: `${folder}/doc.pdf`, pages: [1] },
    });
    const text = toolText(result);
    assert(text.startsWith(`[${TOOL_PDF_READ_PAGES}]`), text);
    assert(text.includes("pages 1 of 2"), text);
    assertEquals(result.content.filter((c) => c.type === "image").length, 1);
  } finally {
    await removeDirRetry(root);
  }
});

Deno.test("pdf tool renders a real PDF with the bundled renderer", async () => {
  const { root, folder } = await fixture();
  try {
    await Deno.copyFile(
      join(import.meta.dirname!, "testdata", "two-pages.pdf"),
      join(root, "doc.pdf"),
    );
    // The default renderer is Deno-native (no external process), so this
    // runs on every host.
    const tools = createPdfTools({ sandbox: new Sandbox([root]) });
    const result = await tools[0]!.execute("id", {
      path: `${folder}/doc.pdf`,
      pages: [2],
    });
    const text = toolText(result);
    assert(text.includes("pages 2 of 2"), text);
    const images = result.content.filter((c) => c.type === "image");
    assertEquals(images.length, 1);
    const image = images[0]!;
    assert(image.type === "image" && image.mimeType === "image/png");
    const decoded = Uint8Array.from(
      atob(image.data),
      (c) => c.charCodeAt(0),
    );
    // PNG magic.
    assertEquals(
      decoded.slice(0, 8),
      new Uint8Array([
        0x89,
        0x50,
        0x4e,
        0x47,
        0x0d,
        0x0a,
        0x1a,
        0x0a,
      ]),
    );
    // IHDR dimensions: floor(595pt * 150/72) x floor(842pt * 150/72).
    const view = new DataView(decoded.buffer);
    assertEquals(view.getUint32(16), 1239);
    assertEquals(view.getUint32(20), 1754);
    assertEquals(result.details, {
      path: join(root, "doc.pdf"),
      pages: [2],
      totalPages: 2,
      dpi: DEFAULT_PDF_DPI,
    });
  } finally {
    await removeDirRetry(root);
  }
});

Deno.test("pdf tool fails fast on malformed and encrypted PDFs", async () => {
  const { root, folder } = await fixture();
  try {
    const tools = createPdfTools({ sandbox: new Sandbox([root]) });
    const tool = tools[0]!;
    await assertRejects(
      () => tool.execute("id", { path: `${folder}/doc.pdf`, pages: [1] }),
      Error,
      "Invalid PDF structure",
    );
    await Deno.copyFile(
      join(import.meta.dirname!, "testdata", "encrypted.pdf"),
      join(root, "locked.pdf"),
    );
    await assertRejects(
      () => tool.execute("id", { path: `${folder}/locked.pdf`, pages: [1] }),
      Error,
      "password",
    );
  } finally {
    await removeDirRetry(root);
  }
});
