import { basename, join } from "node:path";
import { realpathSync } from "node:fs";
import { assert, assertEquals } from "@std/assert";
import { Sandbox } from "../workspace/sandbox.ts";
import { errorMessage } from "../errors.ts";
import { GitignoreMatcher } from "./gitignore.ts";
import { createGlobTool, createGrepTool, globToRegExp } from "./search.ts";

function makeTools(root: string) {
  const sandbox = new Sandbox([root]);
  const ctx = { sandbox };
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
async function fixture(prefix = "lumisca-search-"): Promise<string> {
  const root = realpathSync(
    await Deno.makeTempDir({ prefix }),
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

Deno.test("grep searches hidden files and node_modules by default, skips binary files", async () => {
  const root = await fixture();
  try {
    const { grep } = makeTools(root);
    const result = await grep.execute("1", { pattern: "foo" }, undefined);
    const text = toolText(result);
    assertEquals(text.includes(`${join(root, "a.ts")}:1:`), true);
    assertEquals(text.includes("node_modules"), true);
    assertEquals(text.includes(".hidden"), true);
    assertEquals(text.includes("bin.dat"), false); // binary (NUL byte)
    // "foo" matches a.ts:1, sub/c.ts:1 ("FOO"), node_modules/pkg/d.ts:1 and
    // .hidden/e.ts:1 — the default is case-insensitive.
    assertEquals(result.details?.matches, 4);
    assertEquals(result.details?.files, 4);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("grep is case-insensitive by default and honors case", async () => {
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
      { pattern: "foo", case: true },
      undefined,
    );
    assertEquals(toolText(sensitive).includes("sub"), false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("grep respects .gitignore by default and gitignore: false includes them", async () => {
  const root = await fixture();
  try {
    const { grep } = makeTools(root);
    await Deno.mkdir(join(root, "generated"), { recursive: true });
    await Deno.writeTextFile(join(root, "generated", "out.txt"), "foo bar\n");
    await Deno.writeTextFile(
      join(root, ".gitignore"),
      "node_modules/\ngenerated/\n",
    );

    const skipped = await grep.execute("1", { pattern: "foo" }, undefined);
    const skippedText = toolText(skipped);
    assertEquals(skipped.details?.matches, 3); // a.ts, sub/c.ts, .hidden/e.ts
    assertEquals(skippedText.includes("node_modules"), false);
    assertEquals(skippedText.includes("out.txt"), false);

    const included = await grep.execute(
      "1",
      { pattern: "foo", gitignore: false },
      undefined,
    );
    const includedText = toolText(included);
    assertEquals(included.details?.matches, 5);
    assertEquals(includedText.includes("out.txt"), true);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("grep applies .gitignore rules when path targets a subdirectory", async () => {
  const root = await fixture();
  try {
    await Deno.writeTextFile(join(root, ".gitignore"), "*.log\n");
    await Deno.writeTextFile(join(root, "sub", "app.log"), "foo\n");
    const { grep } = makeTools(root);
    const skipped = await grep.execute(
      "1",
      { pattern: "foo", path: join(root, "sub") },
      undefined,
    );
    const skippedText = toolText(skipped);
    assertEquals(skippedText.includes("app.log"), false);
    assertEquals(skippedText.includes("c.ts"), true); // sub/c.ts still searched

    const included = await grep.execute(
      "1",
      { pattern: "foo", path: join(root, "sub"), gitignore: false },
      undefined,
    );
    assertEquals(toolText(included).includes("app.log"), true);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("grep honors negated .gitignore rules", async () => {
  const root = await fixture();
  try {
    await Deno.writeTextFile(
      join(root, ".gitignore"),
      "*.log\n!important.log\n",
    );
    await Deno.writeTextFile(join(root, "app.log"), "foo\n");
    await Deno.mkdir(join(root, "logs"), { recursive: true });
    await Deno.writeTextFile(join(root, "logs", "app.log"), "foo\n");
    await Deno.writeTextFile(join(root, "important.log"), "foo\n");

    const { grep } = makeTools(root);
    const result = await grep.execute("1", { pattern: "foo" }, undefined);
    const text = toolText(result);
    assertEquals(text.includes("app.log"), false); // any depth
    assertEquals(text.includes("logs"), false);
    assertEquals(text.includes("important.log"), true); // re-included
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("GitignoreMatcher applies git rule semantics", async () => {
  const root = await fixture("lumisca-gi-");
  try {
    await Deno.writeTextFile(
      join(root, ".gitignore"),
      [
        "# comment",
        "node_modules/",
        "*.log",
        "/rooted.ts",
        "!important.log",
        "sub/ignored.ts",
      ].join("\n"),
    );
    const matcher = await GitignoreMatcher.load([root]);
    // Dir-only rule matches directories, not files with the same name.
    assertEquals(matcher.ignores(root, "node_modules", true), true);
    assertEquals(matcher.ignores(root, "node_modules", false), false);
    // Basename patterns match at any depth, and files too.
    assertEquals(matcher.ignores(root, "app.log", false), true);
    assertEquals(matcher.ignores(root, "deep/dir/app.log", false), true);
    // Leading `/` anchors the pattern to the root.
    assertEquals(matcher.ignores(root, "rooted.ts", false), true);
    assertEquals(matcher.ignores(root, "sub/rooted.ts", false), false);
    // Negation wins as the last matching rule.
    assertEquals(matcher.ignores(root, "important.log", false), false);
    // A pattern containing `/` is anchored.
    assertEquals(matcher.ignores(root, "sub/ignored.ts", false), true);
    assertEquals(matcher.ignores(root, "ignored.ts", false), false);
    // Unmatched paths are not ignored.
    assertEquals(matcher.ignores(root, "a.ts", false), false);
    // A subdirectory walk root (the resolved `path` argument) resolves to
    // the owning root's rules, with paths re-based onto that root.
    assertEquals(matcher.ignores(join(root, "deep"), "app.log", false), true);
    assertEquals(matcher.ignores(join(root, "sub"), "ignored.ts", false), true);
    // Anchored rules stay anchored to the root, not the subdirectory.
    assertEquals(matcher.ignores(join(root, "sub"), "rooted.ts", false), false);
    assertEquals(matcher.ignores(join(root, "sub"), "c.ts", false), false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("grep with an explicit path bypasses filters and caps results", async () => {
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
      message = errorMessage(error);
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
      message = errorMessage(error);
    }
    assert(message.includes("Invalid pattern"), `message: ${message}`);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("grep and glob reject overly long patterns (ReDoS bound)", async () => {
  const root = await fixture();
  try {
    const { grep, glob } = makeTools(root);
    let grepMessage = "";
    try {
      await grep.execute(
        "1",
        { pattern: "a".repeat(300) },
        undefined,
      );
    } catch (error) {
      grepMessage = errorMessage(error);
    }
    assert(
      grepMessage.includes("pattern is too long"),
      `grep message: ${grepMessage}`,
    );
    let globMessage = "";
    try {
      await glob.execute(
        "1",
        { pattern: "a".repeat(2000) },
        undefined,
      );
    } catch (error) {
      globMessage = errorMessage(error);
    }
    assert(
      globMessage.includes("pattern is too long"),
      `glob message: ${globMessage}`,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("glob finds files by pattern, searching hidden files by default", async () => {
  const root = await fixture();
  try {
    const { glob } = makeTools(root);
    const result = await glob.execute("1", { pattern: "**/*.ts" }, undefined);
    const text = toolText(result);
    assertEquals(text.includes(join(root, "a.ts")), true);
    assertEquals(text.includes(join(root, "sub", "c.ts")), true);
    assertEquals(text.includes("b.js"), false);
    assertEquals(text.includes("node_modules"), true);
    assertEquals(text.includes(".hidden"), true);
    // a.ts, sub/c.ts, node_modules/pkg/d.ts, .hidden/e.ts
    assertEquals(result.details?.count, 4);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("glob skips hidden files with hidden: false", async () => {
  const root = await fixture();
  try {
    const { glob } = makeTools(root);
    const result = await glob.execute(
      "1",
      { pattern: "**/*.ts", hidden: false },
      undefined,
    );
    const text = toolText(result);
    assertEquals(text.includes(join(root, "a.ts")), true);
    assertEquals(text.includes(join(root, "sub", "c.ts")), true);
    // node_modules is not hidden; it is only excluded via .gitignore.
    assertEquals(text.includes("node_modules"), true);
    assertEquals(text.includes(".hidden"), false);
    // a.ts, sub/c.ts, node_modules/pkg/d.ts
    assertEquals(result.details?.count, 3);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("glob respects .gitignore by default and gitignore: false includes them", async () => {
  const root = await fixture();
  try {
    const { glob } = makeTools(root);
    await Deno.writeTextFile(join(root, ".gitignore"), "node_modules/\n");

    const skipped = await glob.execute("1", { pattern: "**/*.ts" }, undefined);
    const skippedText = toolText(skipped);
    // a.ts, sub/c.ts, .hidden/e.ts — node_modules is gitignored.
    assertEquals(skipped.details?.count, 3);
    assertEquals(skippedText.includes("node_modules"), false);

    const included = await glob.execute(
      "1",
      { pattern: "**/*.ts", gitignore: false },
      undefined,
    );
    assertEquals(included.details?.count, 4);

    // hidden: false + gitignore: false — hidden excluded, but non-hidden
    // gitignored files (node_modules) included.
    const noHiddenNoIgnore = await glob.execute(
      "1",
      { pattern: "**/*.ts", hidden: false, gitignore: false },
      undefined,
    );
    assertEquals(noHiddenNoIgnore.details?.count, 3);
    assertEquals(toolText(noHiddenNoIgnore).includes("node_modules"), true);
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
    assertEquals(braces.details?.count, 5);

    const scoped = await glob.execute(
      "1",
      { pattern: "**/*.ts", path: `${basename(root)}/sub` },
      undefined,
    );
    assertEquals(toolText(scoped).includes("c.ts"), true);
    assertEquals(toolText(scoped).includes("a.ts"), false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("grep and glob always skip build-artifact and VCS directories", async () => {
  const root = await fixture();
  try {
    await Deno.mkdir(join(root, "dist", "assets"), { recursive: true });
    await Deno.writeTextFile(
      join(root, "dist", "assets", "bundle.js"),
      "const foo = 7;\n",
    );
    await Deno.mkdir(join(root, "target", "debug"), { recursive: true });
    await Deno.writeTextFile(
      join(root, "target", "debug", "main.rs"),
      "const foo = 8;\n",
    );
    await Deno.mkdir(join(root, ".git", "refs"), { recursive: true });
    await Deno.writeTextFile(join(root, ".git", "refs", "head"), "foo\n");

    const { grep, glob } = makeTools(root);
    // gitignore:false + hidden search でも常に除外される
    const grepResult = await grep.execute(
      "1",
      { pattern: "foo", gitignore: false },
      undefined,
    );
    const grepText = toolText(grepResult);
    assertEquals(grepText.includes("dist"), false);
    assertEquals(grepText.includes("target"), false);
    assertEquals(grepText.includes(".git"), false);
    // a.ts, sub/c.ts, node_modules/pkg/d.ts, .hidden/e.ts
    assertEquals(grepResult.details?.matches, 4);

    const globResult = await glob.execute(
      "1",
      { pattern: "**/*", gitignore: false },
      undefined,
    );
    const globText = toolText(globResult);
    assertEquals(globText.includes("dist"), false);
    assertEquals(globText.includes("target"), false);
    assertEquals(globText.includes(".git"), false);
    assertEquals(globResult.details?.count, 6); // a.ts, b.js, sub/c.ts, node_modules/pkg/d.ts, .hidden/e.ts, bin.dat
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("grep and glob search every workspace folder when path is omitted", async () => {
  const first = await fixture();
  const second = await fixture();
  try {
    const sandbox = new Sandbox([first, second]);
    const ctx = { sandbox };
    const grep = createGrepTool(ctx);
    const glob = createGlobTool(ctx);

    const grepResult = await grep.execute("1", { pattern: "bar" }, undefined);
    assertEquals(grepResult.details?.matches, 2); // b.js in both folders
    assertEquals(toolText(grepResult).includes(join(first, "b.js")), true);
    assertEquals(toolText(grepResult).includes(join(second, "b.js")), true);

    const globResult = await glob.execute(
      "1",
      { pattern: "**/*.ts" },
      undefined,
    );
    // a.ts + sub/c.ts + node_modules/pkg/d.ts + .hidden/e.ts in both
    assertEquals(globResult.details?.count, 8);
  } finally {
    await Deno.remove(first, { recursive: true });
    await Deno.remove(second, { recursive: true });
  }
});

Deno.test("grep and glob results are independent of folder registration order", async () => {
  const a = await fixture("lumisca-aaa-");
  const z = await fixture("lumisca-zzz-");
  try {
    const grep = (sandbox: Sandbox) =>
      createGrepTool({ sandbox }).execute(
        "1",
        { pattern: "const", max_results: 2 },
        undefined,
      );
    const glob = (sandbox: Sandbox) =>
      createGlobTool({ sandbox }).execute(
        "1",
        { pattern: "**/*.ts" },
        undefined,
      );

    // The cap is hit inside the first (path-sorted) root; the second root
    // must never contribute, in either registration order.
    const r1 = await grep(new Sandbox([a, z]));
    const r2 = await grep(new Sandbox([z, a]));
    assertEquals(toolText(r1), toolText(r2));
    assertEquals(r1.details?.matches, 2);
    assertEquals(toolText(r1).includes(a), true);
    assertEquals(toolText(r1).includes(z), false);

    const g1 = await glob(new Sandbox([a, z]));
    const g2 = await glob(new Sandbox([z, a]));
    assertEquals(toolText(g1), toolText(g2));
    assertEquals(g1.details?.count, 8);
  } finally {
    await Deno.remove(a, { recursive: true });
    await Deno.remove(z, { recursive: true });
  }
});
