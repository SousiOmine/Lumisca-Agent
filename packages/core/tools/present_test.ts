import { basename, join } from "node:path";
import { assertEquals, assertRejects } from "@std/assert";
import { Sandbox } from "../workspace/sandbox.ts";
import { createPresentTool } from "./present.ts";
import { makeRealTempDir, removeDirRetry, toolText } from "../test-utils.ts";

function makePresent(root: string) {
  return createPresentTool({ sandbox: new Sandbox([root]) });
}

async function fixture(): Promise<{ root: string; folder: string }> {
  const root = await makeRealTempDir("lumisca-present-");
  await Deno.writeTextFile(join(root, "output.txt"), "result data\n");
  await Deno.writeTextFile(join(root, "report.md"), "# Report\n");
  return { root, folder: basename(root) };
}

Deno.test("present declares existing files and returns list text", async () => {
  const { root, folder } = await fixture();
  try {
    const result = await makePresent(root).execute("id", {
      files: [{ path: `${folder}/output.txt` }],
    });
    const text = toolText(result);
    assertEquals(text, `${folder}/output.txt`);
    assertEquals(result.details.files, [
      { path: `${folder}/output.txt` },
    ]);
  } finally {
    await removeDirRetry(root);
  }
});

Deno.test("present includes description when provided", async () => {
  const { root, folder } = await fixture();
  try {
    const result = await makePresent(root).execute("id", {
      files: [
        { path: `${folder}/output.txt`, description: "The final output" },
      ],
    });
    const text = toolText(result);
    assertEquals(
      text,
      `${folder}/output.txt — The final output`,
    );
    assertEquals(result.details.files, [
      { path: `${folder}/output.txt`, description: "The final output" },
    ]);
  } finally {
    await removeDirRetry(root);
  }
});

Deno.test("present handles multiple files", async () => {
  const { root, folder } = await fixture();
  try {
    const result = await makePresent(root).execute("id", {
      files: [
        { path: `${folder}/output.txt`, description: "Data file" },
        { path: `${folder}/report.md` },
      ],
    });
    const text = toolText(result);
    assertEquals(
      text,
      `${folder}/output.txt — Data file\n${folder}/report.md`,
    );
    assertEquals(result.details.files, [
      { path: `${folder}/output.txt`, description: "Data file" },
      { path: `${folder}/report.md` },
    ]);
  } finally {
    await removeDirRetry(root);
  }
});

Deno.test("present fails for a non-existent file", async () => {
  const { root, folder } = await fixture();
  try {
    await assertRejects(
      () =>
        makePresent(root).execute("id", {
          files: [{ path: `${folder}/nope.txt` }],
        }),
      Error,
    );
  } finally {
    await removeDirRetry(root);
  }
});

Deno.test("present fails for a directory", async () => {
  const { root, folder } = await fixture();
  try {
    await Deno.mkdir(join(root, "subdir"));
    await assertRejects(
      () =>
        makePresent(root).execute("id", {
          files: [{ path: `${folder}/subdir` }],
        }),
      Error,
      "Is a directory",
    );
  } finally {
    await removeDirRetry(root);
  }
});

Deno.test("present fails for a path outside the sandbox", async () => {
  const { root } = await fixture();
  try {
    await assertRejects(
      () =>
        makePresent(root).execute("id", {
          files: [{ path: "/etc/passwd" }],
        }),
      Error,
    );
  } finally {
    await removeDirRetry(root);
  }
});

Deno.test("present omits description from details when not provided", async () => {
  const { root, folder } = await fixture();
  try {
    const result = await makePresent(root).execute("id", {
      files: [{ path: `${folder}/output.txt` }],
    });
    const file = result.details.files as Array<Record<string, unknown>>;
    assertEquals(file.length, 1);
    assertEquals("description" in file[0]!, false);
  } finally {
    await removeDirRetry(root);
  }
});
