import { join } from "node:path";
import { realpathSync } from "node:fs";
import { assert, assertEquals } from "@std/assert";
import { findRepoRoot, loadProjectMemoryFiles } from "./agents-md.ts";

/** Realpath'd temp dir: makeTempDir may return 8.3 short names on Windows
 * (e.g. `MAINPC~1`), which would break path equality assertions. */
function tempDir(prefix: string): Promise<string> {
  return Deno.makeTempDir({ prefix }).then((p) => realpathSync(p));
}

Deno.test("findRepoRoot locates the .git marker", async () => {
  const root = await tempDir("lumisca-mem-");
  try {
    await Deno.mkdir(join(root, "sub", "deep"), { recursive: true });
    await Deno.mkdir(join(root, ".git"), { recursive: true });
    assertEquals(findRepoRoot(join(root, "sub", "deep")), realpathSync(root));
    // A .git file (worktree / submodule) counts too.
    await Deno.remove(join(root, ".git"), { recursive: true });
    await Deno.writeTextFile(join(root, ".git"), "gitdir: ../other\n");
    assertEquals(findRepoRoot(join(root, "sub")), realpathSync(root));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("findRepoRoot falls back to the folder itself", async () => {
  const root = await tempDir("lumisca-mem-");
  try {
    assertEquals(findRepoRoot(root), realpathSync(root));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("loadProjectMemoryFiles reads AGENTS.md from the workspace root", async () => {
  const root = await tempDir("lumisca-mem-");
  try {
    await Deno.writeTextFile(join(root, "AGENTS.md"), "Use Deno.\n");
    const files = loadProjectMemoryFiles([root]);
    assertEquals(files.length, 1);
    assertEquals(files[0]!.path, join(realpathSync(root), "AGENTS.md"));
    assertEquals(files[0]!.content, "Use Deno.\n");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("loadProjectMemoryFiles collects the chain root-first", async () => {
  const root = await tempDir("lumisca-mem-");
  try {
    await Deno.mkdir(join(root, ".git"), { recursive: true });
    await Deno.mkdir(join(root, "sub", "deep"), { recursive: true });
    await Deno.writeTextFile(join(root, "AGENTS.md"), "ROOT_MEMORY");
    await Deno.writeTextFile(join(root, "sub", "AGENTS.md"), "SUB_MEMORY");
    await Deno.writeTextFile(
      join(root, "sub", "deep", "AGENTS.md"),
      "DEEP_MEMORY",
    );
    const files = loadProjectMemoryFiles([join(root, "sub", "deep")]);
    assertEquals(files.map((f) => f.content), [
      "ROOT_MEMORY",
      "SUB_MEMORY",
      "DEEP_MEMORY",
    ]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("AGENTS.override.md replaces AGENTS.md in the same directory", async () => {
  const root = await tempDir("lumisca-mem-");
  try {
    await Deno.writeTextFile(join(root, "AGENTS.md"), "OLD");
    await Deno.writeTextFile(join(root, "AGENTS.override.md"), "NEW");
    const files = loadProjectMemoryFiles([root]);
    assertEquals(files.length, 1);
    assertEquals(files[0]!.content, "NEW");
    assertEquals(
      files[0]!.path,
      join(realpathSync(root), "AGENTS.override.md"),
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("loadProjectMemoryFiles reaches the repo root above the folder", async () => {
  const root = await tempDir("lumisca-mem-");
  try {
    await Deno.mkdir(join(root, ".git"), { recursive: true });
    await Deno.mkdir(join(root, "sub"), { recursive: true });
    await Deno.writeTextFile(join(root, "AGENTS.md"), "REPO_ROOT");
    await Deno.writeTextFile(join(root, "sub", "AGENTS.md"), "SUBDIR");
    const files = loadProjectMemoryFiles([join(root, "sub")]);
    assertEquals(files.map((f) => f.content), ["REPO_ROOT", "SUBDIR"]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("loadProjectMemoryFiles caps the contents at 32KB", async () => {
  const root = await tempDir("lumisca-mem-");
  try {
    await Deno.writeTextFile(join(root, "AGENTS.md"), "x".repeat(40 * 1024));
    const files = loadProjectMemoryFiles([root]);
    const total = files.reduce((sum, file) => sum + file.content.length, 0);
    assert(total <= 32 * 1024, `memory too large: ${total}`);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("loadProjectMemoryFiles returns nothing when no file exists", async () => {
  const root = await tempDir("lumisca-mem-");
  try {
    assertEquals(loadProjectMemoryFiles([root]), []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
