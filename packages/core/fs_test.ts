import { assertEquals } from "@std/assert";
import { dirname, join } from "node:path";
import { atomicWriteTextFileSync, isRecord, readIfExists } from "./fs.ts";
import { bytesToBase64 } from "./base64.ts";
import { makeRealTempDir, removeDirRetry } from "./test-utils.ts";

Deno.test("atomicWriteTextFileSync writes the file and creates the parent", async () => {
  const root = await makeRealTempDir("lumisca-atomic-");
  try {
    const target = join(root, "nested", "deep", "settings.jsonc");
    atomicWriteTextFileSync(target, "{}\n");
    assertEquals(await Deno.readTextFile(target), "{}\n");
    // The temp file must not survive the write.
    const names: string[] = [];
    for await (const entry of Deno.readDir(dirname(target))) {
      names.push(entry.name);
    }
    assertEquals(names, ["settings.jsonc"]);
  } finally {
    await removeDirRetry(root);
  }
});

Deno.test("atomicWriteTextFileSync replaces an existing file in place", async () => {
  const root = await makeRealTempDir("lumisca-atomic-");
  try {
    const target = join(root, "settings.jsonc");
    atomicWriteTextFileSync(target, "first\n");
    atomicWriteTextFileSync(target, "second\n");
    assertEquals(await Deno.readTextFile(target), "second\n");
  } finally {
    await removeDirRetry(root);
  }
});

Deno.test("readIfExists returns undefined for a missing path", async () => {
  const root = await makeRealTempDir("lumisca-fs-");
  try {
    assertEquals(readIfExists(join(root, "absent.txt")), undefined);
    const present = join(root, "present.txt");
    await Deno.writeTextFile(present, "hi");
    assertEquals(readIfExists(present), "hi");
  } finally {
    await removeDirRetry(root);
  }
});

Deno.test("isRecord accepts plain records only", () => {
  assertEquals(isRecord({}), true);
  assertEquals(isRecord({ a: 1 }), true);
  assertEquals(isRecord([]), false);
  assertEquals(isRecord(null), false);
  assertEquals(isRecord("x"), false);
  assertEquals(isRecord(1), false);
});

Deno.test("bytesToBase64 encodes across the chunk boundary", () => {
  assertEquals(bytesToBase64(new Uint8Array([0x68, 0x69])), "aGk=");
  assertEquals(bytesToBase64(new Uint8Array(0)), "");
  // 0x8000 is the chunk size: a longer buffer proves the chunked loop is
  // equivalent to a single-shot encode.
  const big = new Uint8Array(0x8000 + 3);
  for (let i = 0; i < big.length; i++) big[i] = i % 256;
  let binary = "";
  for (const byte of big) binary += String.fromCharCode(byte);
  assertEquals(bytesToBase64(big), btoa(binary));
});
