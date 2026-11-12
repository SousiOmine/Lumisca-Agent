import { join } from "node:path";
import { assert, assertEquals } from "@std/assert";
import { Sandbox } from "../../workspace/sandbox.ts";
import { HostFileBackend } from "./files.ts";

/** A temp folder plus the backend whose sandbox is that folder. */
async function fixture(): Promise<{ root: string; files: HostFileBackend }> {
  const root = await Deno.realPath(await Deno.makeTempDir());
  return { root, files: new HostFileBackend(new Sandbox([root])) };
}

Deno.test("host files: readBytes returns one window, and less at the end", async () => {
  const { root, files } = await fixture();
  const path = join(root, "hello.txt");
  try {
    await Deno.writeTextFile(path, "hello");
    assertEquals(
      new TextDecoder().decode(await files.readBytes(path, 1, 3)),
      "ell",
    );
    // A window that runs past the end is short, which is how a transfer
    // learns the file ended.
    assertEquals(
      new TextDecoder().decode(await files.readBytes(path, 4, 10)),
      "o",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("host files: writeBytes truncates first, then appends", async () => {
  const { root, files } = await fixture();
  const path = join(root, "nested", "a.bin");
  try {
    await files.writeBytes(path, new Uint8Array([1, 2, 3, 4]));
    await files.writeBytes(path, new Uint8Array([5, 6]), { append: true });
    assertEquals([...(await Deno.readFile(path))], [1, 2, 3, 4, 5, 6]);
    // A second transfer starts over: the shorter file must not keep the tail
    // of the longer one that was there before.
    await files.writeBytes(path, new Uint8Array([9]));
    assertEquals([...(await Deno.readFile(path))], [9]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("host files: a private write is owner-only", async () => {
  if (Deno.build.os === "windows") return;
  const { root, files } = await fixture();
  const path = join(root, "secret.bin");
  try {
    await files.writeBytes(path, new Uint8Array([1]), { private: true });
    const mode = (await Deno.stat(path)).mode ?? 0;
    assert((mode & 0o777) === 0o600, `mode ${(mode & 0o777).toString(8)}`);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
