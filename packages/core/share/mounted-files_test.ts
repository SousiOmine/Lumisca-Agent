import { assert, assertEquals, assertRejects } from "@std/assert";
import { SHARE_ROOT, shareRootOf } from "./grant.ts";
import { MountedFiles } from "./mounted-files.ts";
import {
  answerOf,
  FakeBackend,
  grantOf,
  RecordingTransport,
} from "./test-utils.ts";

function mounted(grants: ReturnType<typeof grantOf>[]) {
  const primary = new FakeBackend(["/home/agent"]);
  const transport = new RecordingTransport(answerOf);
  const files = new MountedFiles(primary, transport, () => grants);
  return { primary, transport, files };
}

Deno.test("a lent folder is addressable only by its absolute path", async () => {
  const { files, transport } = mounted([grantOf({ name: "proj" })]);
  const root = shareRootOf("proj");

  const ok = await files.resolve(`${root}/src/a.ts`);
  assertEquals(ok, { ok: true, path: `${root}/src/a.ts` });
  // The session's own paths keep their own rules.
  assertEquals(await files.resolve("notes.md"), {
    ok: true,
    path: "/home/agent/notes.md",
  });
  // A relative path never reaches a lent folder: it resolves against the
  // session's working folder like any other relative path.
  assertEquals(await files.resolve("proj/src/a.ts"), {
    ok: true,
    path: "/home/agent/proj/src/a.ts",
  });
  // A path the session's own backend refuses names where the lent folders
  // are, so a model that guessed has the absolute form in the refusal.
  const outside = await files.resolve("/etc/passwd");
  assertEquals(outside.ok, false);
  if (!outside.ok) {
    assert(
      outside.reason.includes(root),
      `should name ${root}: ${outside.reason}`,
    );
  }
  // None of that asked the lent computer anything.
  assertEquals(transport.calls.length, 0);
});

Deno.test("an unknown lent name is refused with the names that exist", async () => {
  const { files } = mounted([
    grantOf({ name: "proj" }),
    grantOf({ id: "g2", name: "data" }),
  ]);
  const result = await files.resolve(`${SHARE_ROOT}/nope/x`);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assert(result.reason.includes("/lend/proj"), result.reason);
    assert(result.reason.includes("/lend/data"), result.reason);
  }
});

Deno.test("a path that climbs out of the grant is not the grant's", async () => {
  const { files, transport } = mounted([grantOf({ name: "proj" })]);
  const result = await files.resolve(`${shareRootOf("proj")}/../../etc/passwd`);
  assertEquals(result.ok, false);
  assertEquals(transport.calls.length, 0);
});

Deno.test("operations are routed by the longest matching root", async () => {
  const grants = [
    grantOf({ id: "a", name: "proj" }),
    grantOf({ id: "b", name: "proj-src" }),
  ];
  const { files, transport, primary } = mounted(grants);

  await files.readText(`${shareRootOf("proj-src")}/x`);
  assertEquals(transport.calls[0]?.grantId, "b");
  assertEquals(transport.calls[0]?.call, {
    op: "readText",
    path: ["x"],
    maxBytes: 4 * 1024 * 1024,
  });

  await files.readText(`${shareRootOf("proj")}/x`);
  assertEquals(transport.calls[1]?.grantId, "a");

  await files.readText("/home/agent/notes.md");
  assertEquals(transport.calls.length, 2);
  assertEquals(primary.calls[0]?.op, "readText");
});

Deno.test("the session's own roots come first, so spills stay on its machine", async () => {
  const { files } = mounted([grantOf({ name: "proj" })]);
  assertEquals(files.roots, ["/home/agent", "/lend/proj"]);
});

Deno.test("a read-only loan refuses writes in the backend, not in a tool", async () => {
  const { files, transport } = mounted([
    grantOf({ name: "proj", write: false }),
  ]);
  const root = shareRootOf("proj");
  await assertRejects(
    () => files.writeText(`${root}/a.txt`, "x"),
    Error,
    "lent read-only",
  );
  await assertRejects(
    () => files.removeFile(`${root}/a.txt`),
    Error,
    "read-only",
  );
  // Refused here: the lent computer never saw the write at all.
  assertEquals(transport.calls.length, 0);
});

Deno.test("a writable loan sends the text to the lent computer", async () => {
  const { files, transport } = mounted([grantOf({ name: "proj" })]);
  await files.writeText(`${shareRootOf("proj")}/a.txt`, "hi", {
    private: true,
  });
  assertEquals(transport.last(), {
    op: "writeText",
    path: ["a.txt"],
    text: "hi",
    private: true,
  });
});

Deno.test("the namespace root lists the lent folders", async () => {
  const { files, transport } = mounted([
    grantOf({ id: "a", name: "proj" }),
    grantOf({ id: "b", name: "data" }),
  ]);
  assertEquals(await files.resolve(SHARE_ROOT), { ok: true, path: SHARE_ROOT });
  assertEquals(await files.stat(SHARE_ROOT), { isFile: false, size: 0 });
  assertEquals(await files.listDir(SHARE_ROOT), [
    { name: "proj", isDirectory: true, isSymlink: false },
    { name: "data", isDirectory: true, isSymlink: false },
  ]);
  // Listing the namespace is answered locally: no call per folder.
  assertEquals(transport.calls.length, 0);
});

Deno.test("the namespace root is not a folder to read, write or delete", async () => {
  const { files, primary } = mounted([grantOf({ name: "proj" })]);
  await assertRejects(() => files.readText(SHARE_ROOT), Error, "not one");
  await assertRejects(() => files.writeText(SHARE_ROOT, "x"), Error, "not one");
  await assertRejects(() => files.removeFile(SHARE_ROOT), Error, "not one");
  // Nothing reached the server's own filesystem.
  assertEquals(primary.calls.length, 0);
});

Deno.test("nothing is lent: the namespace does not exist", async () => {
  const { files } = mounted([]);
  const root = await files.resolve(SHARE_ROOT);
  assertEquals(root.ok, false);
  assertEquals(await files.stat(SHARE_ROOT), undefined);
  assertEquals(await files.listDir(SHARE_ROOT), []);
});

Deno.test("an expired grant stops resolving", async () => {
  const { files } = mounted([
    grantOf({ name: "proj", expiresAt: Date.now() - 1 }),
  ]);
  const result = await files.resolve(`${shareRootOf("proj")}/a.txt`);
  assertEquals(result.ok, false);
  if (!result.ok)
    assert(result.reason.includes("no longer lent"), result.reason);
});
