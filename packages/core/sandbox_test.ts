import { join } from "node:path";
import { realpathSync } from "node:fs";
import { assertEquals } from "@std/assert";
import { Sandbox } from "./mod.ts";

function tempDir(prefix: string): Promise<string> {
  return Deno.makeTempDir({ prefix });
}

function real(p: string): string {
  return realpathSync(p);
}

Deno.test("sandbox resolves paths inside the workspace", async () => {
  const root = await tempDir("lumisca-sb-");
  const sandbox = new Sandbox([root]);
  const file = join(root, "sub", "file.txt");
  await Deno.mkdir(join(root, "sub"), { recursive: true });
  await Deno.writeTextFile(file, "x");

  const r1 = await sandbox.resolve(file, root);
  assertEquals(r1.ok, true);
  if (r1.ok) assertEquals(r1.path, real(file));

  const r2 = await sandbox.resolve("sub/file.txt", root);
  assertEquals(r2.ok, true);

  const r3 = await sandbox.resolve(join(root, "sub"), root);
  assertEquals(r3.ok, true);

  await Deno.remove(root, { recursive: true });
});

Deno.test("sandbox rejects paths outside the workspace", async () => {
  const root = await tempDir("lumisca-sb-");
  const outside = await tempDir("lumisca-outside-");
  const sandbox = new Sandbox([root]);

  const r1 = await sandbox.resolve(join(outside, "file.txt"), root);
  assertEquals(r1.ok, false);

  const r2 = await sandbox.resolve("../outside.txt", root);
  assertEquals(r2.ok, false);

  const r3 = await sandbox.resolve(join(root, "..", "..", ".."), root);
  assertEquals(r3.ok, false);

  await Deno.remove(root, { recursive: true });
  await Deno.remove(outside, { recursive: true });
});

Deno.test("sandbox allows writing to not-yet-existing files inside the workspace", async () => {
  const root = await tempDir("lumisca-sb-");
  const sandbox = new Sandbox([root]);
  const target = join(root, "new", "file.txt");

  const r = await sandbox.resolve(target, root);
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
  const r = await sandbox.resolve(deep, root);
  assertEquals(r.ok, true);
  if (r.ok) assertEquals(r.path, join(real(root), "a", "b", "c", "file.txt"));

  // The same for a path with a single missing parent directory.
  const shallow = join(root, "new", "file.txt");
  const r2 = await sandbox.resolve(shallow, root);
  assertEquals(r2.ok, true);
  if (r2.ok) assertEquals(r2.path, join(real(root), "new", "file.txt"));

  // A write through that path must land on the full target (after the
  // parents are created, mirroring what write_file does).
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

Deno.test("sandbox rejects workspace folders that do not exist", async () => {
  const r = await Sandbox.resolveFolder("Z:\\definitely\\not\\here\\lumisca");
  assertEquals(r.ok, false);
});
