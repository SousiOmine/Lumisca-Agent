import { test } from "bun:test";
import * as fsSync from "node:fs";
import { realpathSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { tmpdir as osTmpdir } from "node:os";
import { basename, join, join as pathJoin } from "node:path";
import { assertEquals } from "@std/assert";
import { Sandbox } from "./mod.ts";
import { removeDirRetry } from "./test-utils.ts";

function tempDir(prefix: string): Promise<string> {
  return fsp.mkdtemp(pathJoin(osTmpdir(), prefix));
}

function real(p: string): string {
  return realpathSync.native(p);
}

test("sandbox resolves absolute paths inside the workspace", async () => {
  const root = await tempDir("lumisca-sb-");
  const sandbox = new Sandbox([root]);
  const file = join(root, "sub", "file.txt");
  await fsp.mkdir(join(root, "sub"), { recursive: true });
  await fsp.writeFile(file, "x");

  const r1 = await sandbox.resolve(file);
  assertEquals(r1.ok, true);
  if (r1.ok) assertEquals(r1.path, real(file));

  const r3 = await sandbox.resolve(join(root, "sub"));
  assertEquals(r3.ok, true);

  await fsp.rm(root, { recursive: true });
});

test("sandbox resolves workspace-folder-relative paths", async () => {
  const root = await tempDir("lumisca-sb-");
  const sandbox = new Sandbox([root]);
  const file = join(root, "sub", "file.txt");
  await fsp.mkdir(join(root, "sub"), { recursive: true });
  await fsp.writeFile(file, "x");

  // The first segment must name the workspace folder.
  const r1 = await sandbox.resolve(`${basename(root)}/sub/file.txt`);
  assertEquals(r1.ok, true);
  if (r1.ok) assertEquals(r1.path, real(file));

  // The bare folder name resolves to the root itself.
  const r2 = await sandbox.resolve(basename(root));
  assertEquals(r2.ok, true);
  if (r2.ok) assertEquals(r2.path, real(root));

  await fsp.rm(root, { recursive: true });
});

test("sandbox resolves each folder of a multi-folder workspace by name", async () => {
  const aaa = await tempDir("lumisca-aaa-");
  const star = await tempDir("lumisca-star-");
  const nitro = await tempDir("lumisca-nitro-");
  try {
    const sandbox = new Sandbox([aaa, star, nitro]);
    await fsp.writeFile(join(aaa, "README.md"), "aaa");
    await fsp.mkdir(join(star, "Assets"), { recursive: true });
    await fsp.writeFile(join(star, "Assets", "icon.png"), "png");
    await fsp.writeFile(join(nitro, "notes.txt"), "notes");

    const r1 = await sandbox.resolve(`${basename(aaa)}/README.md`);
    assertEquals(r1.ok, true);
    if (r1.ok) assertEquals(r1.path, real(join(aaa, "README.md")));

    const r2 = await sandbox.resolve(`${basename(star)}/Assets`);
    assertEquals(r2.ok, true);
    if (r2.ok) assertEquals(r2.path, real(join(star, "Assets")));

    // Absolute paths keep working for any folder.
    const r3 = await sandbox.resolve(join(nitro, "notes.txt"));
    assertEquals(r3.ok, true);
  } finally {
    await fsp.rm(aaa, { recursive: true });
    await fsp.rm(star, { recursive: true });
    await fsp.rm(nitro, { recursive: true });
  }
});

test("sandbox matches folder names case-insensitively on Windows", async () => {
  const root = await tempDir("lumisca-case-");
  try {
    const sandbox = new Sandbox([root]);
    const r = await sandbox.resolve(`${basename(root).toUpperCase()}/file.txt`);
    if (
      (process.platform === "win32" ? "windows" : process.platform) ===
      "windows"
    ) {
      assertEquals(r.ok, true);
    } else {
      assertEquals(r.ok, false);
    }
  } finally {
    await fsp.rm(root, { recursive: true });
  }
});

test("sandbox roots are sorted by path regardless of registration order", async () => {
  const a = await tempDir("lumisca-aaa-");
  const z = await tempDir("lumisca-zzz-");
  try {
    const sortKey = (p: string) => p.replace(/\\/g, "/").toLowerCase();
    const expected = [real(a), real(z)].sort((x, y) =>
      sortKey(x) < sortKey(y) ? -1 : sortKey(x) > sortKey(y) ? 1 : 0,
    );

    const sandbox = new Sandbox([z, a]);
    assertEquals(sandbox.roots, expected);
  } finally {
    await fsp.rm(a, { recursive: true });
    await fsp.rm(z, { recursive: true });
  }
});

test("sandbox rejects paths outside the workspace", async () => {
  const root = await tempDir("lumisca-sb-");
  const outside = await tempDir("lumisca-outside-");
  const sandbox = new Sandbox([root]);

  const r1 = await sandbox.resolve(join(outside, "file.txt"));
  assertEquals(r1.ok, false);

  const r2 = await sandbox.resolve(`${basename(root)}/../outside.txt`);
  assertEquals(r2.ok, false);

  const r3 = await sandbox.resolve(join(root, "..", "..", ".."));
  assertEquals(r3.ok, false);

  await fsp.rm(root, { recursive: true });
  await fsp.rm(outside, { recursive: true });
});

test("sandbox rejects paths without a workspace folder name", async () => {
  const root = await tempDir("lumisca-sb-");
  const sandbox = new Sandbox([root]);

  const r = await sandbox.resolve("sub/file.txt");
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.reason.includes("Unknown workspace folder"), true);

  await fsp.rm(root, { recursive: true });
});

test("sandbox rejects an ambiguous folder name", async () => {
  const parent = await fsp.mkdtemp(pathJoin(osTmpdir(), "lumisca-amb-"));
  const one = join(parent, "same");
  const two = join(parent, "other", "same");
  await fsp.mkdir(one);
  await fsp.mkdir(join(parent, "other"), { recursive: true });
  try {
    const sandbox = new Sandbox([one, two]);
    const r = await sandbox.resolve("same/file.txt");
    assertEquals(r.ok, false);
    if (!r.ok) assertEquals(r.reason.includes("Ambiguous"), true);
  } finally {
    await removeDirRetry(parent);
  }
});

test("sandbox allows writing to not-yet-existing files inside the workspace", async () => {
  const root = await tempDir("lumisca-sb-");
  const sandbox = new Sandbox([root]);
  const target = join(root, "new", "file.txt");

  const r = await sandbox.resolve(target);
  assertEquals(r.ok, true);
  if (r.ok) assertEquals(r.path, join(real(root), "new", "file.txt"));

  await fsp.rm(root, { recursive: true });
});

test("sandbox resolves deep new paths in full (no truncation)", async () => {
  const root = await tempDir("lumisca-sb-");
  const sandbox = new Sandbox([root]);

  // Two missing segments below the deepest existing ancestor: the resolved
  // path must keep every segment, not just the deepest ancestor + 1.
  const deep = join(root, "a", "b", "c", "file.txt");
  const r = await sandbox.resolve(deep);
  assertEquals(r.ok, true);
  if (r.ok) assertEquals(r.path, join(real(root), "a", "b", "c", "file.txt"));

  // The same for a path with a single missing parent directory.
  const shallow = join(root, "new", "file.txt");
  const r2 = await sandbox.resolve(shallow);
  assertEquals(r2.ok, true);
  if (r2.ok) assertEquals(r2.path, join(real(root), "new", "file.txt"));

  // A write through that path must land on the full target (after the
  // parents are created, mirroring what write does).
  await fsp.mkdir(join(real(root), "a", "b", "c"), { recursive: true });
  await fsp.writeFile(r.ok ? r.path : "", "content");
  assertEquals(
    await fsp.readFile(join(real(root), "a", "b", "c", "file.txt"), "utf8"),
    "content",
  );
  // The intermediate directories must stay directories (no stray file).
  const aStat = fsSync.statSync(join(real(root), "a"));
  assertEquals(aStat.isDirectory(), true);
  assertEquals(aStat.isFile(), false);

  await fsp.rm(root, { recursive: true });
});

test("sandbox resolves new files via folder-relative paths", async () => {
  const root = await tempDir("lumisca-sb-");
  const sandbox = new Sandbox([root]);

  const r = await sandbox.resolve(`${basename(root)}/new/deep/file.txt`);
  assertEquals(r.ok, true);
  if (r.ok) {
    assertEquals(r.path, join(real(root), "new", "deep", "file.txt"));
  }

  await fsp.rm(root, { recursive: true });
});

test("sandbox rejects workspace folders that do not exist", async () => {
  const r = await Sandbox.resolveFolder("Z:\\definitely\\not\\here\\lumisca");
  assertEquals(r.ok, false);
});

test("sandbox: an extra root is reachable by absolute path, not by name", async () => {
  const root = await tempDir("lumisca-sb-");
  // The shared skills folder, outside the workspace and named like a folder
  // a repository could have.
  const sharedParent = await tempDir("lumisca-shared-");
  const shared = join(sharedParent, "skills");
  await fsp.mkdir(join(shared, "release-notes"), { recursive: true });
  try {
    const sandbox = new Sandbox([root], { extraRoots: [shared] });
    // `roots` still means the workspace folders only: the first one is where
    // oversized tool output is spilled, and a repo folder called `skills`
    // must not become ambiguous.
    assertEquals(sandbox.roots.map(real), [real(root)]);

    const abs = await sandbox.resolve(
      join(shared, "release-notes", "SKILL.md"),
    );
    assertEquals(abs.ok, true);
    if (abs.ok) {
      assertEquals(abs.path, join(real(shared), "release-notes", "SKILL.md"));
    }

    // A relative path cannot name an extra root.
    const rel = await sandbox.resolve("skills/release-notes/SKILL.md");
    assertEquals(rel.ok, false);

    // ...and a path outside every root is still refused.
    const outside = await sandbox.resolve(
      join(shared, "..", "elsewhere", "SKILL.md"),
    );
    assertEquals(outside.ok, false);
  } finally {
    await fsp.rm(root, { recursive: true });
    await fsp.rm(sharedParent, { recursive: true });
  }
});

test("sandbox: a workspace folder named like the extra root stays unambiguous", async () => {
  // A repository whose workspace folder is called `skills`, next to a
  // shared folder of the same name: the relative path must mean the
  // workspace folder (the extra root never takes part in name matching).
  const parent = await tempDir("lumisca-sb-");
  const workspaceSkills = join(parent, "skills");
  await fsp.mkdir(join(workspaceSkills, "mine"), { recursive: true });
  const sharedParent = await tempDir("lumisca-shared-");
  const shared = join(sharedParent, "skills");
  try {
    const sandbox = new Sandbox([workspaceSkills], { extraRoots: [shared] });
    const rel = await sandbox.resolve("skills/mine/SKILL.md");
    assertEquals(rel.ok, true);
    if (rel.ok) {
      assertEquals(rel.path, join(real(workspaceSkills), "mine", "SKILL.md"));
    }
  } finally {
    await fsp.rm(parent, { recursive: true });
    await fsp.rm(sharedParent, { recursive: true });
  }
});
