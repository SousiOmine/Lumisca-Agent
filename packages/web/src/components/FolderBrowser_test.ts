import { assertEquals } from "@std/assert";
import type { FsEntry } from "../types.ts";
import { isHiddenEntry, visibleEntries } from "./FolderBrowser.tsx";

/** Helper: a folder entry of a browsed listing. */
function dir(name: string): FsEntry {
  return { name, path: `/home/me/${name}`, kind: "dir" };
}

/** Helper: a file entry of a browsed listing. */
function file(name: string): FsEntry {
  return { name, path: `/home/me/${name}`, kind: "file" };
}

Deno.test("isHiddenEntry: the dot-prefix rule of the file managers", () => {
  assertEquals(isHiddenEntry(dir(".config")), true);
  assertEquals(isHiddenEntry(file(".zshrc")), true);
  // A dot inside a name is not a hidden entry.
  assertEquals(isHiddenEntry(dir("Documents")), false);
  assertEquals(isHiddenEntry(file("notes.md")), false);
});

Deno.test("visibleEntries: hidden entries stay out until they are asked for", () => {
  // The server's order: folders by name, then files. The dot-names sort
  // first, which is exactly why they are held back.
  const entries = [
    dir(".cache"),
    dir(".config"),
    dir("Documents"),
    dir("lumisca"),
    file(".zshrc"),
    file("notes.md"),
  ];
  assertEquals(visibleEntries(entries, false), [
    dir("Documents"),
    dir("lumisca"),
    file("notes.md"),
  ]);
  // Asked for: the listing is shown as it came, nothing is reordered.
  assertEquals(visibleEntries(entries, true), entries);
});

Deno.test("visibleEntries: a folder of nothing but hidden entries is empty", () => {
  assertEquals(visibleEntries([dir(".ssh"), file(".gitconfig")], false), []);
  assertEquals(visibleEntries([], false), []);
  assertEquals(visibleEntries([], true), []);
});
