import { assertEquals } from "@std/assert";
import {
  folderName,
  forgetFolder,
  loadRecentFolders,
  MAX_RECENT_FOLDERS,
  type RecentShareFolder,
  rememberFolder,
} from "./share-recents.ts";

/** The two methods this module uses, over a Map (no `localStorage` under the
 * test runner, and a real one would leak between tests). */
function memoryStorage(initial: string | null = null) {
  let value = initial;
  return {
    getItem: (_key: string) => value,
    setItem: (_key: string, next: string) => {
      value = next;
    },
    written: () => value,
  };
}

function folder(path: string, overrides: Partial<RecentShareFolder> = {}) {
  return {
    path,
    name: folderName(path),
    write: false,
    exec: true,
    ...overrides,
  };
}

Deno.test("share recents: a folder is remembered once, newest first", () => {
  const storage = memoryStorage();
  rememberFolder(folder("/Users/me/proj"), storage);
  rememberFolder(folder("/Users/me/notes"), storage);
  rememberFolder(folder("/Users/me/proj", { write: true }), storage);

  const folders = loadRecentFolders(storage);
  assertEquals(
    folders.map((entry) => entry.path),
    ["/Users/me/proj", "/Users/me/notes"],
  );
  // The terms saved are the ones used last: a re-lend repeats that choice.
  assertEquals(folders[0]?.write, true);
});

Deno.test("share recents: the list is capped", () => {
  const storage = memoryStorage();
  for (let i = 0; i < MAX_RECENT_FOLDERS + 2; i++) {
    rememberFolder(folder(`/tmp/f${i}`), storage);
  }
  const folders = loadRecentFolders(storage);
  assertEquals(folders.length, MAX_RECENT_FOLDERS);
  assertEquals(folders[0]?.path, `/tmp/f${MAX_RECENT_FOLDERS + 1}`);
});

Deno.test("share recents: bad storage data is an empty list, not a crash", () => {
  assertEquals(loadRecentFolders(memoryStorage("not json")), []);
  assertEquals(loadRecentFolders(memoryStorage('{"a":1}')), []);
  assertEquals(loadRecentFolders(memoryStorage('[1, null, {"path":3}]')), []);
});

Deno.test("share recents: a missing name is derived from the path", () => {
  const storage = memoryStorage('[{"path":"/Users/me/proj"}]');
  assertEquals(loadRecentFolders(storage)[0]?.name, "proj");
});

Deno.test("share recents: forget drops one path and leaves the rest", () => {
  const storage = memoryStorage();
  rememberFolder(folder("/tmp/a"), storage);
  rememberFolder(folder("/tmp/b"), storage);
  const left = forgetFolder("/tmp/a", storage);
  assertEquals(
    left.map((entry) => entry.path),
    ["/tmp/b"],
  );
  assertEquals(
    loadRecentFolders(storage).map((entry) => entry.path),
    ["/tmp/b"],
  );
});

Deno.test("folderName keeps the last segment of either separator", () => {
  assertEquals(folderName("/Users/me/proj"), "proj");
  assertEquals(folderName("C:\\Users\\me\\proj"), "proj");
  assertEquals(folderName("/Users/me/proj/"), "proj");
});
