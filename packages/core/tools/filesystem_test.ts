import { basename, join } from "node:path";
import { realpathSync } from "node:fs";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { Sandbox } from "../workspace/sandbox.ts";
import {
  createEditFileTool,
  createReadFileTool,
  createWriteFileTool,
} from "./filesystem.ts";

/** Minimal 1x1 transparent PNG (67 bytes). */
const MINI_PNG = new Uint8Array([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
  0x00,
  0x00,
  0x00,
  0x0d,
  0x49,
  0x48,
  0x44,
  0x52,
  0x00,
  0x00,
  0x00,
  0x01,
  0x00,
  0x00,
  0x00,
  0x01,
  0x08,
  0x06,
  0x00,
  0x00,
  0x00,
  0x1f,
  0x15,
  0xc4,
  0x89,
  0x00,
  0x00,
  0x00,
  0x0d,
  0x49,
  0x44,
  0x41,
  0x54,
  0x78,
  0x9c,
  0x62,
  0x00,
  0x01,
  0x00,
  0x00,
  0x05,
  0x00,
  0x01,
  0x0d,
  0x0a,
  0x2d,
  0xb4,
  0x00,
  0x00,
  0x00,
  0x00,
  0x49,
  0x45,
  0x4e,
  0x44,
  0xae,
  0x42,
  0x60,
  0x82,
]);

function makeRead(root: string) {
  return createReadFileTool({ sandbox: new Sandbox([root]) });
}

function toolText(result: { content: { type: string; text?: string }[] }) {
  return result.content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("");
}

/** Content after the `--- path lines spec ---` header line. */
function bodyOf(text: string): string {
  return text.slice(text.indexOf("\n") + 1);
}

async function fixture(): Promise<{ root: string; folder: string }> {
  const root = realpathSync(
    await Deno.makeTempDir({ prefix: "lumisca-read-" }),
  );
  await Deno.writeFile(join(root, "pic.png"), MINI_PNG);
  await Deno.writeTextFile(join(root, "notes.txt"), "hello world\n");
  await Deno.writeTextFile(join(root, "drawing.svg"), "<svg></svg>");
  await Deno.writeTextFile(
    join(root, "main.ts"),
    Array.from({ length: 15 }, (_, i) => `line ${i + 1}`).join("\n") + "\n",
  );
  return { root, folder: basename(root) };
}

Deno.test("read passes raster images to the model as image blocks", async () => {
  const { root, folder } = await fixture();
  try {
    const result = await makeRead(root).execute("id", {
      path: `${folder}/pic.png`,
    });
    const images = result.content.filter((c) => c.type === "image");
    assertEquals(images.length, 1);
    assertEquals(images[0]?.mimeType, "image/png");
    const decoded = Uint8Array.from(
      atob(images[0]!.data),
      (c) => c.charCodeAt(0),
    );
    assertEquals(decoded, MINI_PNG);
    // A text note keeps the image visible in text-only UIs (CLI).
    const text = toolText(result);
    assert(text.includes("[image: pic.png"), `note missing: ${text}`);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("read maps common image extensions to mime types", async () => {
  const { root, folder } = await fixture();
  try {
    for (
      const [ext, mime] of [
        [".jpg", "image/jpeg"],
        [".jpeg", "image/jpeg"],
        [".gif", "image/gif"],
        [".webp", "image/webp"],
        [".bmp", "image/bmp"],
        [".PNG", "image/png"], // case-insensitive
      ] as const
    ) {
      const name = `photo${ext}`;
      await Deno.writeFile(join(root, name), MINI_PNG);
      const result = await makeRead(root).execute("id", {
        path: `${folder}/${name}`,
      });
      const image = result.content.find((c) => c.type === "image");
      assertEquals(image?.mimeType, mime, ext);
      await Deno.remove(join(root, name));
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("read keeps text, SVG and line-ranged reads on the text path", async () => {
  const { root, folder } = await fixture();
  try {
    const read = makeRead(root);
    for (const name of ["notes.txt", "drawing.svg"]) {
      const result = await read.execute("id", { path: `${folder}/${name}` });
      assertEquals(
        result.content.filter((c) => c.type === "image").length,
        0,
        `${name} must stay text`,
      );
    }
    // Line-ranged reads of an image stay text.
    const partial = await read.execute("id", {
      path: `${folder}/pic.png:1+1`,
    });
    assertEquals(partial.content.filter((c) => c.type === "image").length, 0);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("read extracts line ranges from the path", async () => {
  const { root, folder } = await fixture();
  try {
    const result = await makeRead(root).execute("id", {
      path: `${folder}/main.ts:5-8`,
    });
    const text = toolText(result);
    assert(
      text.startsWith(`--- ${folder}/main.ts lines 5-8 ---`),
      `header missing: ${text}`,
    );
    assertEquals(bodyOf(text), "line 5\nline 6\nline 7\nline 8");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("read supports single lines, N+M and comma-separated ranges", async () => {
  const { root, folder } = await fixture();
  try {
    const read = makeRead(root);
    const single = await read.execute("id", { path: `${folder}/main.ts:7` });
    assertEquals(bodyOf(toolText(single)), "line 7");

    const plus = await read.execute("id", { path: `${folder}/main.ts:10+3` });
    const plusText = toolText(plus);
    assert(
      plusText.startsWith(`--- ${folder}/main.ts lines 10+3 ---`),
      `header missing: ${plusText}`,
    );
    assertEquals(bodyOf(plusText), "line 10\nline 11\nline 12");

    const multi = await read.execute("id", {
      path: `${folder}/main.ts:2-3,10-11`,
    });
    const multiText = toolText(multi);
    assert(
      multiText.startsWith(`--- ${folder}/main.ts lines 2-3,10-11 ---`),
      `header missing: ${multiText}`,
    );
    // Output follows file order, not the order of the ranges.
    assertEquals(bodyOf(multiText), "line 2\nline 3\nline 10\nline 11");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("read rejects invalid line ranges", async () => {
  const { root, folder } = await fixture();
  try {
    const read = makeRead(root);
    for (
      const path of [
        `${folder}/main.ts:50-2`, // end before start
        `${folder}/main.ts:0-5`, // line numbers start at 1
        `${folder}/main.ts:50+0`, // empty range
      ]
    ) {
      await assertRejects(
        () => read.execute("id", { path }),
        Error,
        "Invalid line range",
        `expected rejection for ${path}`,
      );
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("read notes when a range extends past the end of the file", async () => {
  const { root, folder } = await fixture();
  try {
    const result = await makeRead(root).execute("id", {
      path: `${folder}/main.ts:5-20`,
    });
    const text = toolText(result);
    assertEquals(bodyOf(text).split("\n")[0] ?? "", "line 5");
    assert(text.endsWith("[end of file: 15 lines]"), text);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("read suggests a line range when a large file is cut off", async () => {
  const root = realpathSync(
    await Deno.makeTempDir({ prefix: "lumisca-read-" }),
  );
  const folder = basename(root);
  try {
    // ~600KB, so the whole-file read caps at the 512KB chunk limit.
    await Deno.writeTextFile(join(root, "big.txt"), "x".repeat(600 * 1024));
    const result = await makeRead(root).execute("id", {
      path: `${folder}/big.txt`,
    });
    const text = toolText(result);
    assert(text.includes("[file continues; read with"), text);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("read line ranges stay memory-bounded on huge single-line files", async () => {
  const root = realpathSync(
    await Deno.makeTempDir({ prefix: "lumisca-read-" }),
  );
  const folder = basename(root);
  try {
    // A 4MB line with no newlines — far beyond any output budget; the
    // read must keep only its tail instead of buffering the whole file.
    const tail = "TAILMARKER";
    await Deno.writeTextFile(
      join(root, "huge.txt"),
      "x".repeat(4 * 1024 * 1024 - tail.length) + tail,
    );
    const result = await makeRead(root).execute("id", {
      path: `${folder}/huge.txt:1`,
    });
    const text = toolText(result);
    assert(text.includes(tail), `tail missing: ${text.slice(-100)}`);
    assert(text.length < 200 * 1024, `output too large: ${text.length}`);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// --- edit / write / line endings -------------------------------------------

/** Write a file with CRLF line endings. */
async function writeCrlf(path: string, lines: string[]): Promise<void> {
  await Deno.writeFile(
    path,
    new TextEncoder().encode(lines.join("\r\n") + "\r\n"),
  );
}

function makeFs(root: string) {
  const sandbox = new Sandbox([root]);
  return {
    edit: createEditFileTool({ sandbox }),
    write: createWriteFileTool({ sandbox }),
  };
}

/** A temp dir plus `folder` (basename) for tool paths, like `fixture`. */
async function fsFixture(): Promise<{ root: string; folder: string }> {
  const root = realpathSync(
    await Deno.makeTempDir({ prefix: "lumisca-fs-" }),
  );
  return { root, folder: basename(root) };
}

Deno.test("edit matches CRLF files with an LF old_string and keeps CRLF", async () => {
  const { root, folder } = await fsFixture();
  const file = join(root, "sample.txt");
  try {
    await writeCrlf(file, ["const a = 1;", "const b = 2;", "const c = 3;"]);
    const result = await makeFs(root).edit.execute("id", {
      path: `${folder}/sample.txt`,
      old_string: "const a = 1;\nconst b = 2;", // LF, as models typically send
      new_string: "const a = 1;\nconst b = 20;", // LF too
    });
    assert(toolText(result).startsWith("Edited"), toolText(result));
    const text = new TextDecoder().decode(await Deno.readFile(file));
    assertEquals(text, "const a = 1;\r\nconst b = 20;\r\nconst c = 3;\r\n");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("edit matches CRLF files with a CRLF old_string", async () => {
  const { root, folder } = await fsFixture();
  const file = join(root, "sample.txt");
  try {
    await writeCrlf(file, ["const a = 1;", "const b = 2;", "const c = 3;"]);
    await makeFs(root).edit.execute("id", {
      path: `${folder}/sample.txt`,
      old_string: "const a = 1;\r\nconst b = 2;",
      new_string: "const a = 1;\r\nconst b = 20;",
    });
    const text = new TextDecoder().decode(await Deno.readFile(file));
    assertEquals(text, "const a = 1;\r\nconst b = 20;\r\nconst c = 3;\r\n");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("edit matches LF files with a CRLF old_string", async () => {
  const { root, folder } = await fsFixture();
  const file = join(root, "sample.txt");
  try {
    await Deno.writeTextFile(
      file,
      "const a = 1;\nconst b = 2;\nconst c = 3;\n",
    );
    await makeFs(root).edit.execute("id", {
      path: `${folder}/sample.txt`,
      old_string: "const a = 1;\r\nconst b = 2;",
      new_string: "const a = 1;\nconst b = 20;",
    });
    const text = new TextDecoder().decode(await Deno.readFile(file));
    assertEquals(text, "const a = 1;\nconst b = 20;\nconst c = 3;\n");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("edit converts an LF new_string to CRLF in a CRLF file", async () => {
  const { root, folder } = await fsFixture();
  const file = join(root, "sample.txt");
  try {
    await writeCrlf(file, ["const a = 1;", "const b = 2;", "const c = 3;"]);
    await makeFs(root).edit.execute("id", {
      path: `${folder}/sample.txt`,
      old_string: "const b = 2;",
      new_string: "const b = 20;\nconst d = 4;", // LF only
    });
    const text = new TextDecoder().decode(await Deno.readFile(file));
    // No mixed line endings: the replacement follows the file's CRLF.
    assertEquals(
      text,
      "const a = 1;\r\nconst b = 20;\r\nconst d = 4;\r\nconst c = 3;\r\n",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("edit throws when old_string is missing", async () => {
  const { root, folder } = await fsFixture();
  const file = join(root, "sample.txt");
  try {
    await Deno.writeTextFile(file, "hello\nworld\n");
    await assertRejects(
      () =>
        makeFs(root).edit.execute("id", {
          path: `${folder}/sample.txt`,
          old_string: "nope\nnope",
          new_string: "x",
        }),
      Error,
      "old_string not found",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("edit replaces only the first occurrence and warns", async () => {
  const { root, folder } = await fsFixture();
  const file = join(root, "sample.txt");
  try {
    await Deno.writeTextFile(file, "a\nb\na\nb\n");
    const result = await makeFs(root).edit.execute("id", {
      path: `${folder}/sample.txt`,
      old_string: "a\nb",
      new_string: "A\nB",
    });
    assertEquals(
      new TextDecoder().decode(await Deno.readFile(file)),
      "A\nB\na\nb\n",
    );
    assert(
      toolText(result).includes("appeared 2 times"),
      toolText(result),
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("write keeps an existing CRLF file's line endings", async () => {
  const { root, folder } = await fsFixture();
  const file = join(root, "sample.txt");
  try {
    await writeCrlf(file, ["const a = 1;", "const b = 2;"]);
    await makeFs(root).write.execute("id", {
      path: `${folder}/sample.txt`,
      content: "const a = 1;\nconst b = 20;\nconst c = 3;\n", // LF as sent
    });
    const text = new TextDecoder().decode(await Deno.readFile(file));
    assertEquals(text, "const a = 1;\r\nconst b = 20;\r\nconst c = 3;\r\n");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("write creates new files with line endings as sent", async () => {
  const { root, folder } = await fsFixture();
  const file = join(root, "new.txt");
  try {
    await makeFs(root).write.execute("id", {
      path: `${folder}/new.txt`,
      content: "a\nb\n",
    });
    assertEquals(
      new TextDecoder().decode(await Deno.readFile(file)),
      "a\nb\n",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("read strips CR so CRLF files display as clean LF lines", async () => {
  const { root, folder } = await fsFixture();
  const file = join(root, "crlf.txt");
  try {
    await writeCrlf(file, ["one", "two", "three"]);
    const read = makeRead(root);
    const ranged = toolText(
      await read.execute("id", { path: `${folder}/crlf.txt:1-3` }),
    );
    assertEquals(bodyOf(ranged), "one\ntwo\nthree");
    const whole = toolText(
      await read.execute("id", { path: `${folder}/crlf.txt` }),
    );
    assert(!whole.includes("\r"), `CR leaked into read output: ${whole}`);
    assertEquals(whole, "one\ntwo\nthree\n");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
