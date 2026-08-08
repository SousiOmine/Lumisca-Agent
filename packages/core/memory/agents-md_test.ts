import { join } from "node:path";
import { realpathSync } from "node:fs";
import { assert, assertEquals } from "@std/assert";
import { findRepoRoot, loadProjectMemory } from "./agents-md.ts";

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

Deno.test("loadProjectMemory reads AGENTS.md from the workspace root", async () => {
  const root = await tempDir("lumisca-mem-");
  try {
    await Deno.writeTextFile(join(root, "AGENTS.md"), "Use Deno.\n");
    const memory = loadProjectMemory([root]);
    assert(memory.includes("Use Deno."), memory);
    assert(memory.includes("AGENTS.md"), memory);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("loadProjectMemory concatenates root-first with nested files", async () => {
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
    const memory = loadProjectMemory([join(root, "sub", "deep")]);
    const rootAt = memory.indexOf("ROOT_MEMORY");
    const subAt = memory.indexOf("SUB_MEMORY");
    const deepAt = memory.indexOf("DEEP_MEMORY");
    assert(rootAt !== -1, "root memory missing");
    assert(subAt !== -1, "sub memory missing");
    assert(deepAt !== -1, "deep memory missing");
    assert(rootAt < subAt && subAt < deepAt, "root-first order expected");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("AGENTS.override.md replaces AGENTS.md in the same directory", async () => {
  const root = await tempDir("lumisca-mem-");
  try {
    await Deno.writeTextFile(join(root, "AGENTS.md"), "OLD");
    await Deno.writeTextFile(join(root, "AGENTS.override.md"), "NEW");
    const memory = loadProjectMemory([root]);
    assert(memory.includes("NEW"), memory);
    assert(!memory.includes("OLD"), memory);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("loadProjectMemory reaches the repo root above the workspace folder", async () => {
  const root = await tempDir("lumisca-mem-");
  try {
    await Deno.mkdir(join(root, ".git"), { recursive: true });
    await Deno.mkdir(join(root, "sub"), { recursive: true });
    await Deno.writeTextFile(join(root, "AGENTS.md"), "REPO_ROOT");
    await Deno.writeTextFile(join(root, "sub", "AGENTS.md"), "SUBDIR");
    const memory = loadProjectMemory([join(root, "sub")]);
    assert(memory.includes("REPO_ROOT"), memory);
    assert(memory.includes("SUBDIR"), memory);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("loadProjectMemory caps the total at 32KB", async () => {
  const root = await tempDir("lumisca-mem-");
  try {
    await Deno.writeTextFile(join(root, "AGENTS.md"), "x".repeat(40 * 1024));
    const memory = loadProjectMemory([root]);
    assert(memory.length <= 32 * 1024, `memory too large: ${memory.length}`);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("loadProjectMemory returns empty when nothing exists", async () => {
  const root = await tempDir("lumisca-mem-");
  try {
    assertEquals(loadProjectMemory([root]), "");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
