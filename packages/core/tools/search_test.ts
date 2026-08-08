import { join } from "node:path";
import { realpathSync } from "node:fs";
import { assert, assertEquals } from "@std/assert";
import { Sandbox } from "../workspace/sandbox.ts";
import { createGlobTool, createGrepTool, globToRegExp } from "./search.ts";

function makeTools(root: string) {
  const sandbox = new Sandbox([root]);
  const ctx = { sandbox, cwd: root };
  return {
    grep: createGrepTool(ctx),
    glob: createGlobTool(ctx),
  };
}

function toolText(
  result: { content: { type: "text" | "image"; text?: string }[] },
): string {
  return result.content.map((c) => (c.type === "text" ? (c.text ?? "") : ""))
    .join("");
}

/** Fixture tree used by most tests. The root is realpath'd so that paths
 * match what the sandbox resolves (makeTempDir may return 8.3 short names
 * on Windows, e.g. `MAINPC~1`, which realpathSync expands). */
async function fixture(): Promise<string> {
  const root = realpathSync(
    await Deno.makeTempDir({ prefix: "lumisca-search-" }),
  );
  await Deno.writeTextFile(
    join(root, "a.ts"),
    "const foo = 1;\nconst baz = 2;\n",
  );
  await Deno.writeTextFile(join(root, "b.js"), "const bar = 3;\n");
  await Deno.mkdir(join(root, "sub"), { recursive: true });
  await Deno.writeTextFile(join(root, "sub", "c.ts"), "const FOO = 4;\n");
  await Deno.mkdir(join(root, "node_modules", "pkg"), { recursive: true });
  await Deno.writeTextFile(
    join(root, "node_modules", "pkg", "d.ts"),
    "const foo = 5;\n",
  );
  await Deno.mkdir(join(root, ".hidden"), { recursive: true });
  await Deno.writeTextFile(join(root, ".hidden", "e.ts"), "const foo = 6;\n");
  await Deno.writeTextFile(join(root, "bin.dat"), "foo\x00bar\n");
  return root;
}

Deno.test("globToRegExp handles core patterns", () => {
  assertEquals(globToRegExp("**/*.ts").test("a.ts"), true);
  assertEquals(globToRegExp("**/*.ts").test("sub/deep/a.ts"), true);
  assertEquals(globToRegExp("**/*.ts").test("sub/a.js"), false);
  assertEquals(globToRegExp("a/**/b.ts").test("a/b.ts"), true);
  assertEquals(globToRegExp("a/**/b.ts").test("a/x/y/b.ts"), true);
  assertEquals(globToRegExp("*.ts").test("a.ts"), true);
  assertEquals(globToRegExp("*.ts").test("sub/a.ts"), false);
  assertEquals(globToRegExp("{a,b}.ts").test("a.ts"), true);
  assertEquals(globToRegExp("{a,b}.ts").test("b.ts"), true);
  assertEquals(globToRegExp("{a,b}.ts").test("c.ts"), false);
  assertEquals(globToRegExp("src/?.ts").test("src/a.ts"), true);
  assertEquals(globToRegExp("src/?.ts").test("src/ab.ts"), false);
  // Literal dots must not act as regex wildcards.
  assertEquals(globToRegExp("a.ts").test("aXts"), false);
});

Deno.test("grep finds matches and skips node_modules, hidden and binary files", async () => {
  const root = await fixture();
  try {
    const { grep } = makeTools(root);
    const result = await grep.execute("1", { pattern: "foo" }, undefined);
    const text = toolText(result);
    assertEquals(text.includes(`${join(root, "a.ts")}:1:`), true);
    assertEquals(text.includes("node_modules"), false);
    assertEquals(text.includes(".hidden"), false);
    assertEquals(text.includes("bin.dat"), false);
    // "foo" matches a.ts:1 and sub/c.ts:1 ("FOO" — default is insensitive).
    assertEquals(result.details?.matches, 2);
    assertEquals(result.details?.files, 2);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("grep is case-insensitive by default and honors case_sensitive", async () => {
  const root = await fixture();
  try {
    const { grep } = makeTools(root);
    const insensitive = await grep.execute("1", { pattern: "foo" }, undefined);
    assertEquals(
      toolText(insensitive).includes(`${join(root, "sub", "c.ts")}:1:`),
      true,
    );

    const sensitive = await grep.execute(
      "1",
      { pattern: "foo", case_sensitive: true },
      undefined,
    );
    assertEquals(toolText(sensitive).includes("sub"), false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("grep literal mode treats the pattern as text", async () => {
  const root = await fixture();
  try {
    const { grep } = makeTools(root);
    // "baz" is literal; as a regex it would also be valid, but "." patterns
    // must not match "aXts" — here the fixture only has baz.
    const result = await grep.execute(
      "1",
      { pattern: "b.z", literal: true },
      undefined,
    );
    assertEquals(result.details?.matches, 0);
    const regex = await grep.execute("1", { pattern: "b.z" }, undefined);
    assertEquals(regex.details?.matches, 1);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("grep honors include and exclude filters", async () => {
  const root = await fixture();
  try {
    const { grep } = makeTools(root);
    const include = await grep.execute(
      "1",
      { pattern: "bar", include: ["**/*.js"] },
      undefined,
    );
    assertEquals(toolText(include).includes("b.js"), true);
    assertEquals(toolText(include).includes("a.ts"), false);

    const exclude = await grep.execute(
      "1",
      { pattern: "bar", exclude: ["**/*.ts"] },
      undefined,
    );
    assertEquals(toolText(exclude).includes("b.js"), true);
    assertEquals(toolText(exclude).includes("a.ts"), false);
    // Basename-only pattern filters by name at any depth.
    const byName = await grep.execute(
      "1",
      { pattern: "bar", include: ["*.js"] },
      undefined,
    );
    assertEquals(toolText(byName).includes("b.js"), true);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("grep with an explicit path can search hidden files and caps results", async () => {
  const root = await fixture();
  try {
    const { grep } = makeTools(root);
    const hidden = await grep.execute(
      "1",
      { pattern: "foo", path: join(root, ".hidden", "e.ts") },
      undefined,
    );
    assertEquals(toolText(hidden).includes("e.ts:1:"), true);

    const capped = await grep.execute(
      "1",
      { pattern: "const", max_results: 2 },
      undefined,
    );
    assertEquals(
      toolText(capped).includes("[maximum of 2 matches reached]"),
      true,
    );
    assertEquals(capped.details?.matches, 2);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("grep rejects paths outside the workspace", async () => {
  const root = await fixture();
  const outside = await Deno.makeTempDir({ prefix: "lumisca-search-out-" });
  try {
    const { grep } = makeTools(root);
    let message = "";
    try {
      await grep.execute("1", { pattern: "x", path: outside }, undefined);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert(message.includes("outside the workspace"), `message: ${message}`);
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(outside, { recursive: true });
  }
});

Deno.test("grep reports invalid patterns as errors", async () => {
  const root = await fixture();
  try {
    const { grep } = makeTools(root);
    let message = "";
    try {
      await grep.execute("1", { pattern: "(" }, undefined);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert(message.includes("Invalid pattern"), `message: ${message}`);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("glob finds files by pattern", async () => {
  const root = await fixture();
  try {
    const { glob } = makeTools(root);
    const result = await glob.execute("1", { pattern: "**/*.ts" }, undefined);
    const text = toolText(result);
    assertEquals(text.includes(join(root, "a.ts")), true);
    assertEquals(text.includes(join(root, "sub", "c.ts")), true);
    assertEquals(text.includes("b.js"), false);
    assertEquals(text.includes("node_modules"), false);
    assertEquals(result.details?.count, 2);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("glob supports brace alternation and scoped roots", async () => {
  const root = await fixture();
  try {
    const { glob } = makeTools(root);
    const braces = await glob.execute(
      "1",
      { pattern: "**/*.{js,ts}" },
      undefined,
    );
    assertEquals(toolText(braces).includes("b.js"), true);
    assertEquals(braces.details?.count, 3);

    const scoped = await glob.execute(
      "1",
      { pattern: "**/*.ts", path: "sub" },
      undefined,
    );
    assertEquals(toolText(scoped).includes("c.ts"), true);
    assertEquals(toolText(scoped).includes("a.ts"), false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
