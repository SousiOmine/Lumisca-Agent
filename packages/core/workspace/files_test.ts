import { test } from "bun:test";
import * as fsp from "node:fs/promises";
import { tmpdir as osTmpdir } from "node:os";
import { basename, join, join as pathJoin } from "node:path";
import { assertEquals } from "@std/assert";
import {
  listWorkspaceFiles,
  suggestWorkspaceFiles,
  type Workspace,
  type WorkspaceFileEntry,
} from "../mod.ts";
import { removeDirRetry } from "../test-utils.ts";

function workspace(root: string): Workspace {
  return { id: "w1", name: "ws", folders: [root], createdAt: 0, chat: false };
}

test("listWorkspaceFiles returns folder-relative posix paths", async () => {
  const root = await fsp.mkdtemp(pathJoin(osTmpdir(), "lumisca-files-"));
  try {
    await fsp.mkdir(join(root, "src", "util"), { recursive: true });
    await fsp.writeFile(join(root, "README.md"), "r");
    await fsp.writeFile(join(root, "src", "main.ts"), "m");
    await fsp.writeFile(join(root, "src", "util", "math.ts"), "x");

    const entries = await listWorkspaceFiles(workspace(root));
    const folderName = basename(root);
    assertEquals(
      entries.map((e) => e.path),
      [
        folderName,
        `${folderName}/README.md`,
        `${folderName}/src`,
        `${folderName}/src/main.ts`,
        `${folderName}/src/util`,
        `${folderName}/src/util/math.ts`,
      ],
    );
    const util = entries.find((e) => e.name === "util");
    assertEquals(util?.isDir, true);
    assertEquals(util?.path, `${folderName}/src/util`);
    const main = entries.find((e) => e.name === "main.ts");
    assertEquals(main?.isDir, false);
  } finally {
    await removeDirRetry(root);
  }
});

test("listWorkspaceFiles skips hidden entries, excluded dirs and symlinks", async () => {
  const root = await fsp.mkdtemp(pathJoin(osTmpdir(), "lumisca-files-"));
  try {
    await fsp.mkdir(join(root, "node_modules", "pkg"), { recursive: true });
    await fsp.mkdir(join(root, ".hidden"), { recursive: true });
    await fsp.mkdir(join(root, ".git"), { recursive: true });
    await fsp.writeFile(join(root, ".git", "config"), "g");
    await fsp.writeFile(join(root, "visible.txt"), "v");
    await fsp.writeFile(join(root, ".env"), "e");
    await fsp.writeFile(join(root, "node_modules", "pkg", "index.js"), "i");
    await fsp.mkdir(join(root, "bin", "Release"), { recursive: true });
    await fsp.writeFile(join(root, "bin", "Release", "x.dll"), "b");
    await fsp.mkdir(join(root, "obj"), { recursive: true });
    await fsp.writeFile(join(root, "obj", "file.txt"), "o");
    try {
      await fsp.symlink(join(root, "visible.txt"), join(root, "link.txt"));
    } catch {
      // symlinks may be unavailable (permissions); the walk must not fail
    }

    const entries = await listWorkspaceFiles(workspace(root));
    const paths = entries.map((e) => e.path);
    const folderName = basename(root);
    assertEquals(paths.includes(`${folderName}/visible.txt`), true);
    assertEquals(paths.includes(`${folderName}/.env`), false);
    assertEquals(paths.includes(`${folderName}/.hidden`), false);
    assertEquals(
      paths.some((p) => p.includes("node_modules")),
      false,
    );
    assertEquals(
      paths.some((p) => p.includes(".git")),
      false,
    );
    assertEquals(
      paths.some((p) => p.includes("link.txt")),
      false,
    );
    assertEquals(
      paths.some((p) => p.includes("/bin/")),
      false,
    );
    assertEquals(
      paths.some((p) => p.includes("/obj/")),
      false,
    );
  } finally {
    await removeDirRetry(root);
  }
});

test("listWorkspaceFiles emits files before subdirectories of a level", async () => {
  const root = await fsp.mkdtemp(pathJoin(osTmpdir(), "lumisca-files-"));
  try {
    // `z.txt` sorts after the `a` directory alphabetically, but the walk
    // must still surface it before descending into `a`: a deep tree must
    // not starve later siblings of the entry budget.
    await fsp.writeFile(join(root, "z.txt"), "z");
    await fsp.mkdir(join(root, "a"), { recursive: true });
    await fsp.writeFile(join(root, "a", "inner.txt"), "i");

    const entries = await listWorkspaceFiles(workspace(root));
    const folderName = basename(root);
    assertEquals(
      entries.map((e) => e.path),
      [
        folderName,
        `${folderName}/z.txt`,
        `${folderName}/a`,
        `${folderName}/a/inner.txt`,
      ],
    );
  } finally {
    await removeDirRetry(root);
  }
});

test("listWorkspaceFiles stops at the max entry cap", async () => {
  const root = await fsp.mkdtemp(pathJoin(osTmpdir(), "lumisca-files-"));
  try {
    for (let i = 0; i < 10; i++) {
      await fsp.writeFile(join(root, `f${i}.txt`), "x");
    }
    const entries = await listWorkspaceFiles(workspace(root), 5);
    assertEquals(entries.length, 5);
  } finally {
    await removeDirRetry(root);
  }
});

test("listWorkspaceFiles covers every folder of a multi-folder workspace", async () => {
  const a = await fsp.mkdtemp(pathJoin(osTmpdir(), "lumisca-a-"));
  const b = await fsp.mkdtemp(pathJoin(osTmpdir(), "lumisca-b-"));
  try {
    await fsp.writeFile(join(a, "one.txt"), "1");
    await fsp.writeFile(join(b, "two.txt"), "2");
    const entries = await listWorkspaceFiles({
      id: "w2",
      name: "ws2",
      folders: [a, b],
      createdAt: 0,
      chat: false,
    });
    const paths = entries.map((e) => e.path);
    assertEquals(paths.includes(basename(a)), true);
    assertEquals(paths.includes(`${basename(a)}/one.txt`), true);
    assertEquals(paths.includes(basename(b)), true);
    assertEquals(paths.includes(`${basename(b)}/two.txt`), true);
  } finally {
    await removeDirRetry(a);
    await removeDirRetry(b);
  }
});

const sample: WorkspaceFileEntry[] = [
  { path: "core/mod.ts", name: "mod.ts", isDir: false },
  { path: "core/workspace/files.ts", name: "files.ts", isDir: false },
  { path: "core/workspace", name: "workspace", isDir: true },
  {
    path: "web/src/components/Composer.tsx",
    name: "Composer.tsx",
    isDir: false,
  },
  { path: "web/src/api.ts", name: "api.ts", isDir: false },
  { path: "README.md", name: "README.md", isDir: false },
];

test("suggestWorkspaceFiles returns everything with an empty query", () => {
  assertEquals(
    suggestWorkspaceFiles(sample, "").map((e) => e.path),
    sample.map((e) => e.path),
  );
});

test("suggestWorkspaceFiles ranks basename prefix above contains", () => {
  const sample: WorkspaceFileEntry[] = [
    { path: "z/api-helpers/helper.ts", name: "helper.ts", isDir: false },
    { path: "a/api-client.ts", name: "api-client.ts", isDir: false },
    { path: "web/src/notapi.ts", name: "notapi.ts", isDir: false },
  ];
  const result = suggestWorkspaceFiles(sample, "api").map((e) => e.path);
  // Basename prefix beats basename contains, which beats path contains.
  assertEquals(result, [
    "a/api-client.ts",
    "web/src/notapi.ts",
    "z/api-helpers/helper.ts",
  ]);
});

test("suggestWorkspaceFiles matches case-insensitively", () => {
  const result = suggestWorkspaceFiles(sample, "MOD");
  assertEquals(
    result.some((e) => e.name === "mod.ts"),
    true,
  );
});

test("suggestWorkspaceFiles honors the limit", () => {
  assertEquals(suggestWorkspaceFiles(sample, "e", 2).length, 2);
  assertEquals(suggestWorkspaceFiles(sample, "zzz-no-match").length, 0);
});
