import { basename, join } from "node:path";
import { realpathSync } from "node:fs";
import { assertEquals } from "@std/assert";
import { Sandbox } from "./mod.ts";

function tempDir(prefix: string): Promise<string> {
  return Deno.makeTempDir({ prefix });
}

function real(p: string): string {
  return realpathSync(p);
}

Deno.test("sandbox resolves absolute paths inside the workspace", async () => {
  const root = await tempDir("lumisca-sb-");
  const sandbox = new Sandbox([root]);
  const file = join(root, "sub", "file.txt");
  await Deno.mkdir(join(root, "sub"), { recursive: true });
  await Deno.writeTextFile(file, "x");

  const r1 = await sandbox.resolve(file);
  assertEquals(r1.ok, true);
  if (r1.ok) assertEquals(r1.path, real(file));

  const r3 = await sandbox.resolve(join(root, "sub"));
  assertEquals(r3.ok, true);

  await Deno.remove(root, { recursive: true });
});

Deno.test("sandbox resolves workspace-folder-relative paths", async () => {
  const root = await tempDir("lumisca-sb-");
  const sandbox = new Sandbox([root]);
  const file = join(root, "sub", "file.txt");
  await Deno.mkdir(join(root, "sub"), { recursive: true });
  await Deno.writeTextFile(file, "x");

  // The first segment must name the workspace folder.
  const r1 = await sandbox.resolve(`${basename(root)}/sub/file.txt`);
  assertEquals(r1.ok, true);
  if (r1.ok) assertEquals(r1.path, real(file));

  // The bare folder name resolves to the root itself.
  const r2 = await sandbox.resolve(basename(root));
  assertEquals(r2.ok, true);
  if (r2.ok) assertEquals(r2.path, real(root));

  await Deno.remove(root, { recursive: true });
});

Deno.test("sandbox resolves each folder of a multi-folder workspace by name", async () => {
  const aaa = await tempDir("lumisca-aaa-");
  const star = await tempDir("lumisca-star-");
  const nitro = await tempDir("lumisca-nitro-");
  try {
    const sandbox = new Sandbox([aaa, star, nitro]);
    await Deno.writeTextFile(join(aaa, "README.md"), "aaa");
    await Deno.mkdir(join(star, "Assets"), { recursive: true });
    await Deno.writeTextFile(join(star, "Assets", "icon.png"), "png");
    await Deno.writeTextFile(join(nitro, "notes.txt"), "notes");

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
    await Deno.remove(aaa, { recursive: true });
    await Deno.remove(star, { recursive: true });
    await Deno.remove(nitro, { recursive: true });
  }
});

Deno.test("sandbox matches folder names case-insensitively on Windows", async () => {
  const root = await tempDir("lumisca-case-");
  try {
    const sandbox = new Sandbox([root]);
    const r = await sandbox.resolve(`${basename(root).toUpperCase()}/file.txt`);
    if (Deno.build.os === "windows") {
      assertEquals(r.ok, true);
    } else {
      assertEquals(r.ok, false);
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("sandbox roots are sorted by path regardless of registration order", async () => {
  const a = await tempDir("lumisca-aaa-");
  const z = await tempDir("lumisca-zzz-");
  try {
    const sortKey = (p: string) => p.replace(/\\/g, "/").toLowerCase();
    const expected = [real(a), real(z)].sort((x, y) =>
      sortKey(x) < sortKey(y) ? -1 : sortKey(x) > sortKey(y) ? 1 : 0
    );

    const sandbox = new Sandbox([z, a]);
    assertEquals(sandbox.roots, expected);
  } finally {
    await Deno.remove(a, { recursive: true });
    await Deno.remove(z, { recursive: true });
  }
});

Deno.test("sandbox rejects paths outside the workspace", async () => {
  const root = await tempDir("lumisca-sb-");
  const outside = await tempDir("lumisca-outside-");
  const sandbox = new Sandbox([root]);

  const r1 = await sandbox.resolve(join(outside, "file.txt"));
  assertEquals(r1.ok, false);

  const r2 = await sandbox.resolve(`${basename(root)}/../outside.txt`);
  assertEquals(r2.ok, false);

  const r3 = await sandbox.resolve(join(root, "..", "..", ".."));
  assertEquals(r3.ok, false);

  await Deno.remove(root, { recursive: true });
  await Deno.remove(outside, { recursive: true });
});

Deno.test("sandbox rejects paths without a workspace folder name", async () => {
  const root = await tempDir("lumisca-sb-");
  const sandbox = new Sandbox([root]);

  const r = await sandbox.resolve("sub/file.txt");
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.reason.includes("Unknown workspace folder"), true);

  await Deno.remove(root, { recursive: true });
});

Deno.test("sandbox rejects an ambiguous folder name", async () => {
  const parent = await Deno.makeTempDir({ prefix: "lumisca-amb-" });
  const one = join(parent, "same");
  const two = join(parent, "other", "same");
  await Deno.mkdir(one);
  await Deno.mkdir(join(parent, "other"), { recursive: true });
  try {
    const sandbox = new Sandbox([one, two]);
    const r = await sandbox.resolve("same/file.txt");
    assertEquals(r.ok, false);
    if (!r.ok) assertEquals(r.reason.includes("Ambiguous"), true);
  } finally {
    await Deno.remove(parent, { recursive: true });
  }
});

Deno.test("sandbox allows writing to not-yet-existing files inside the workspace", async () => {
  const root = await tempDir("lumisca-sb-");
  const sandbox = new Sandbox([root]);
  const target = join(root, "new", "file.txt");

  const r = await sandbox.resolve(target);
  assertEquals(r.ok, true);
  if (r.ok) assertEquals(r.path, join(real(root), "new", "file.txt"));

  await Deno.remove(root, { recursive: true });
});

Deno.test("sandbox resolves deep new paths in full (no truncation)", async () => {
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
  await Deno.mkdir(join(real(root), "a", "b", "c"), { recursive: true });
  await Deno.writeTextFile(r.ok ? r.path : "", "content");
  assertEquals(
    await Deno.readTextFile(join(real(root), "a", "b", "c", "file.txt")),
    "content",
  );
  // The intermediate directories must stay directories (no stray file).
  const aStat = Deno.statSync(join(real(root), "a"));
  assertEquals(aStat.isDirectory, true);
  assertEquals(aStat.isFile, false);

  await Deno.remove(root, { recursive: true });
});

Deno.test("sandbox resolves new files via folder-relative paths", async () => {
  const root = await tempDir("lumisca-sb-");
  const sandbox = new Sandbox([root]);

  const r = await sandbox.resolve(`${basename(root)}/new/deep/file.txt`);
  assertEquals(r.ok, true);
  if (r.ok) {
    assertEquals(r.path, join(real(root), "new", "deep", "file.txt"));
  }

  await Deno.remove(root, { recursive: true });
});

Deno.test("sandbox rejects workspace folders that do not exist", async () => {
  const r = await Sandbox.resolveFolder("Z:\\definitely\\not\\here\\lumisca");
  assertEquals(r.ok, false);
});
