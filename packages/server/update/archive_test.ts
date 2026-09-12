import { assertEquals, assertRejects } from "@std/assert";
import { removeDirRetry } from "@lumisca/core/test-utils";
import { ArchiveError, extractArchive, packageEntryName } from "./archive.ts";
import { buildTarGz, buildZip, ustarHeader } from "./test-utils.ts";

const WINDOWS_PREFIX = "lumisca-server-0.7.8-windows-x64";
const LINUX_PREFIX = "lumisca-server-0.7.8-linux-x64";

async function tempDir(): Promise<string> {
  return await Deno.makeTempDir({ prefix: "lumisca-archive-" });
}

async function writeArchive(
  bytes: Uint8Array<ArrayBuffer>,
  name: string,
): Promise<string> {
  const dir = await tempDir();
  const path = `${dir}/${name}`;
  await Deno.writeFile(path, bytes);
  return path;
}

Deno.test("packageEntryName keeps the flat package layout and refuses the rest", () => {
  assertEquals(
    packageEntryName(`${WINDOWS_PREFIX}/lumisca-server.exe`),
    "lumisca-server.exe",
  );
  assertEquals(
    packageEntryName(`${WINDOWS_PREFIX}/assets.json`),
    "assets.json",
  );
  assertEquals(packageEntryName("assets.json"), "assets.json");
  assertEquals(packageEntryName("./dir/icudtl.dat"), "icudtl.dat");

  for (
    const rejected of [
      "",
      "/",
      "../escape.txt",
      `${WINDOWS_PREFIX}/../../escape.txt`,
      `${WINDOWS_PREFIX}/nested/file.txt`,
      `C:/Windows/system32/evil.exe`,
      `${WINDOWS_PREFIX}\\lumisca-server.exe`,
      `${WINDOWS_PREFIX}/.hidden`,
      `${WINDOWS_PREFIX}/name with spaces.txt`,
      `${WINDOWS_PREFIX}/`,
    ]
  ) {
    assertEquals(
      packageEntryName(rejected),
      undefined,
      `must reject ${JSON.stringify(rejected)}`,
    );
  }
});

Deno.test("zip: deflated and stored entries extract with their content", async () => {
  const archive = await writeArchive(
    await buildZip([
      { name: `${WINDOWS_PREFIX}/assets.json`, content: "{}" },
      {
        name: `${WINDOWS_PREFIX}/icudtl.dat`,
        content: "icu-data",
        stored: true,
      },
      { name: `${WINDOWS_PREFIX}/README.txt`, content: "x".repeat(5000) },
    ]),
    "package.zip",
  );
  const out = await tempDir();
  try {
    const written = await extractArchive(archive, "zip", out);
    assertEquals(written, ["assets.json", "icudtl.dat", "README.txt"]);
    assertEquals(await Deno.readTextFile(`${out}/assets.json`), "{}");
    assertEquals(await Deno.readTextFile(`${out}/icudtl.dat`), "icu-data");
    assertEquals((await Deno.readTextFile(`${out}/README.txt`)).length, 5000);
  } finally {
    await removeDirRetry(archive);
    await removeDirRetry(out);
  }
});

Deno.test("tar.gz: entries extract with their content and mode", async () => {
  const archive = await writeArchive(
    await buildTarGz([
      { name: `${LINUX_PREFIX}/lumisca-server`, content: "bin" },
      { name: `${LINUX_PREFIX}/assets.json`, content: "{}" },
    ]),
    "package.tar.gz",
  );
  const out = await tempDir();
  try {
    const written = await extractArchive(archive, "tar.gz", out);
    assertEquals(written, ["lumisca-server", "assets.json"]);
    assertEquals(await Deno.readTextFile(`${out}/lumisca-server`), "bin");
    assertEquals(await Deno.readTextFile(`${out}/assets.json`), "{}");
    if (Deno.build.os !== "windows") {
      const info = await Deno.stat(`${out}/lumisca-server`);
      assertEquals(info.mode! & 0o111, 0o111, "the binary keeps its exec bit");
    }
  } finally {
    await removeDirRetry(archive);
    await removeDirRetry(out);
  }
});

Deno.test("zip: a truncated archive fails instead of writing a half file", async () => {
  const bytes = await buildZip([
    { name: `${WINDOWS_PREFIX}/assets.json`, content: "{}" },
  ]);
  const archive = await writeArchive(
    bytes.subarray(0, bytes.length - 30),
    "cut.zip",
  );
  const out = await tempDir();
  try {
    await assertRejects(
      () => extractArchive(archive, "zip", out),
      ArchiveError,
    );
    assertEquals([...Deno.readDirSync(out)].length, 0);
  } finally {
    await removeDirRetry(archive);
    await removeDirRetry(out);
  }
});

Deno.test("zip: unsafe paths and duplicate names are refused", async () => {
  const escaping = await writeArchive(
    await buildZip([{ name: "../evil.txt", content: "x" }]),
    "escape.zip",
  );
  const nested = await writeArchive(
    await buildZip([{ name: "dir/nested/evil.txt", content: "x" }]),
    "nested.zip",
  );
  const duplicate = await writeArchive(
    await buildZip([
      { name: `${WINDOWS_PREFIX}/assets.json`, content: "a" },
      { name: "other/assets.json", content: "b" },
    ]),
    "duplicate.zip",
  );
  const out = await tempDir();
  try {
    for (const archive of [escaping, nested, duplicate]) {
      await assertRejects(
        () => extractArchive(archive, "zip", out),
        ArchiveError,
      );
    }
    assertEquals([...Deno.readDirSync(out)].length, 0);
  } finally {
    for (const path of [escaping, nested, duplicate]) {
      await removeDirRetry(path);
    }
    await removeDirRetry(out);
  }
});

Deno.test("tar.gz: a symlink entry is refused, not followed", async () => {
  const blocks: Uint8Array<ArrayBuffer>[] = [
    ustarHeader(`${LINUX_PREFIX}/link`, 0, "2"),
    new Uint8Array(1024),
  ];
  const tar = new Uint8Array(
    blocks.reduce((sum, block) => sum + block.length, 0),
  );
  let cursor = 0;
  for (const block of blocks) {
    tar.set(block, cursor);
    cursor += block.length;
  }
  const gz = new Uint8Array(
    await new Response(
      new Blob([tar]).stream().pipeThrough(new CompressionStream("gzip")),
    ).arrayBuffer(),
  );
  const archive = await writeArchive(gz, "link.tar.gz");
  const out = await tempDir();
  try {
    await assertRejects(
      () => extractArchive(archive, "tar.gz", out),
      ArchiveError,
      "未対応のエントリ",
    );
    assertEquals([...Deno.readDirSync(out)].length, 0);
  } finally {
    await removeDirRetry(archive);
    await removeDirRetry(out);
  }
});

Deno.test("tar.gz: metadata entries are skipped, long names are refused", async () => {
  const encoder = new TextEncoder();
  const buildTar = (
    blocks: Uint8Array<ArrayBuffer>[],
  ): Uint8Array<ArrayBuffer> => {
    const tar = new Uint8Array(
      blocks.reduce((sum, block) => sum + block.length, 0),
    );
    let cursor = 0;
    for (const block of blocks) {
      tar.set(block, cursor);
      cursor += block.length;
    }
    return tar;
  };
  const gzip = async (bytes: Uint8Array<ArrayBuffer>) =>
    new Uint8Array(
      await new Response(
        new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip")),
      ).arrayBuffer(),
    );
  const pad = (content: Uint8Array) => {
    const padded = new Uint8Array(Math.ceil(content.length / 512) * 512);
    padded.set(content);
    return padded;
  };

  // A PAX header carrying only metadata (what GNU tar's pax format emits for
  // timestamps) is skipped, and the file after it still lands.
  const metadata = encoder.encode("30 mtime=1700000000.123456789\n");
  const withMetadata = await writeArchive(
    await gzip(
      buildTar([
        ustarHeader(
          `${LINUX_PREFIX}/PaxHeaders/assets.json`,
          metadata.length,
          "x",
        ),
        pad(metadata),
        ustarHeader(`${LINUX_PREFIX}/assets.json`, 2, "0"),
        pad(encoder.encode("{}")),
        new Uint8Array(1024),
      ]),
    ),
    "metadata.tar.gz",
  );
  const out = await tempDir();
  try {
    const written = await extractArchive(withMetadata, "tar.gz", out);
    assertEquals(written, ["assets.json"]);
    assertEquals(await Deno.readTextFile(`${out}/assets.json`), "{}");
  } finally {
    await removeDirRetry(withMetadata);
    await removeDirRetry(out);
  }

  // A PAX header that renames the next entry (a long path) is refused: the
  // name in the following header is truncated, so installing it would put a
  // file somewhere other than the archive says.
  const rename = encoder.encode(
    `40 path=${"a".repeat(200)}/assets.json\n`,
  );
  const withLongName = await writeArchive(
    await gzip(
      buildTar([
        ustarHeader(
          `${LINUX_PREFIX}/PaxHeaders/assets.json`,
          rename.length,
          "x",
        ),
        pad(rename),
        ustarHeader(`${LINUX_PREFIX}/assets.json`, 2, "0"),
        pad(encoder.encode("{}")),
        new Uint8Array(1024),
      ]),
    ),
    "longname.tar.gz",
  );
  const out2 = await tempDir();
  try {
    await assertRejects(
      () => extractArchive(withLongName, "tar.gz", out2),
      ArchiveError,
      "長いパス名",
    );
  } finally {
    await removeDirRetry(withLongName);
    await removeDirRetry(out2);
  }
});
