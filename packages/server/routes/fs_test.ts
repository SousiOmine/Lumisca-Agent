import { assertEquals } from "@std/assert";
import { join, parse, sep } from "node:path";
import { withTempDir } from "@lumisca/core/test-utils";
import {
  breadcrumbs,
  buildPlaces,
  placeCandidates,
  readUserDirs,
} from "./fs.ts";

/** An environment lookup backed by a plain object: the per-platform rules
 * are checked here instead of against the machine running the tests. */
function env(
  values: Record<string, string>,
): (key: string) => string | undefined {
  return (key) => values[key];
}

Deno.test("placeCandidates: the home folders first, then the root", () => {
  const places = placeCandidates(env({ HOME: "/Users/me" }), "darwin");
  assertEquals(places.map((place) => place.kind), [
    "home",
    "desktop",
    "documents",
    "downloads",
    "root",
  ]);
  assertEquals(places[0], { kind: "home", path: "/Users/me" });
  // macOS (and Windows) use the English names; `join` keeps the expectation
  // platform-independent.
  assertEquals(places[1]!.path, join("/Users/me", "Desktop"));
  assertEquals(places[2]!.path, join("/Users/me", "Documents"));
  assertEquals(places[3]!.path, join("/Users/me", "Downloads"));
  assertEquals(places.at(-1), { kind: "root", path: "/" });
});

Deno.test("placeCandidates: Linux prefers the XDG folders", () => {
  const places = placeCandidates(
    env({ HOME: "/home/me", XDG_DESKTOP_DIR: "/home/me/Bureau" }),
    "linux",
  );
  assertEquals(places[1]!.path, "/home/me/Bureau");
  // A folder without an XDG variable keeps the English name.
  assertEquals(places[2]!.path, join("/home/me", "Documents"));
});

Deno.test("placeCandidates: the XDG file fills in for a process without a session", () => {
  // A server started by systemd has no XDG_* variables at all; the file the
  // desktop wrote is the only place the localized names exist.
  const declared: Record<string, string | null> = {
    XDG_DESKTOP_DIR: "/home/me/デスクトップ",
    XDG_DOWNLOAD_DIR: null, // turned off: no place for it
  };
  const places = placeCandidates(
    env({ HOME: "/home/me" }),
    "linux",
    (key) => declared[key],
  );
  assertEquals(places.map((place) => place.kind), [
    "home",
    "desktop",
    "documents",
    "root",
  ]);
  assertEquals(places[1]!.path, "/home/me/デスクトップ");
  // Nothing declares the documents folder: the English name is the fallback.
  assertEquals(places[2]!.path, join("/home/me", "Documents"));
});

Deno.test("placeCandidates: a folder the user turned off is not offered", () => {
  // `$HOME` (or a variable naming it) is how the spec disables a folder.
  const places = placeCandidates(
    env({ HOME: "/home/me", XDG_DOWNLOAD_DIR: "/home/me" }),
    "linux",
  );
  assertEquals(places.some((place) => place.kind === "downloads"), false);
});

Deno.test("readUserDirs: the localized folders of a desktop session", async () => {
  await withTempDir("lumisca-userdirs-", async (root) => {
    const file = join(root, "user-dirs.dirs");
    await Deno.writeTextFile(
      file,
      [
        "# Managed by xdg-user-dirs-update",
        'XDG_DESKTOP_DIR="$HOME/デスクトップ"',
        'XDG_DOCUMENTS_DIR="$HOME/ドキュメント"',
        // The user turned the downloads folder off.
        'XDG_DOWNLOAD_DIR="$HOME/"',
      ].join("\n"),
    );
    const dirs = await readUserDirs(file, "/home/me");
    assertEquals(dirs("XDG_DESKTOP_DIR"), "/home/me/デスクトップ");
    assertEquals(dirs("XDG_DOCUMENTS_DIR"), "/home/me/ドキュメント");
    assertEquals(dirs("XDG_DOWNLOAD_DIR"), null);
    // A folder the file does not name is not a declaration at all.
    assertEquals(dirs("XDG_MUSIC_DIR"), undefined);
  });
});

Deno.test("readUserDirs: without the file nothing is declared", async () => {
  await withTempDir("lumisca-userdirs-", async (root) => {
    const dirs = await readUserDirs(join(root, "user-dirs.dirs"), "/home/me");
    assertEquals(dirs("XDG_DESKTOP_DIR"), undefined);
  });
});

Deno.test("placeCandidates: Windows reads USERPROFILE and offers every drive", () => {
  // A Windows shell may also export HOME (git bash), but USERPROFILE is the
  // Windows-native answer; XDG has no meaning there.
  const places = placeCandidates(
    env({ USERPROFILE: "C:\\Users\\me", HOME: "/c/Users/me" }),
    "windows",
  );
  assertEquals(places[0], { kind: "home", path: "C:\\Users\\me" });
  assertEquals(places[1]!.path, join("C:\\Users\\me", "Desktop"));
  const roots = places.filter((place) => place.kind === "root");
  assertEquals(roots.length, 26, "one entry per drive letter");
  assertEquals(roots[0], { kind: "root", path: "A:\\" });
});

Deno.test("placeCandidates: without a home folder only the root remains", () => {
  assertEquals(placeCandidates(env({}), "darwin"), [
    { kind: "root", path: "/" },
  ]);
});

Deno.test("buildPlaces keeps the existing directories, in order", async () => {
  const places = await buildPlaces(
    [
      { kind: "home", path: "/home/me" },
      { kind: "desktop", path: "/home/me/Desktop" },
      { kind: "root", path: "/" },
    ],
    (path) => Promise.resolve(path !== "/home/me/Desktop"),
  );
  assertEquals(places, [
    { kind: "home", path: "/home/me" },
    { kind: "root", path: "/" },
  ]);
});

Deno.test("breadcrumbs: one step per segment, from the root down", () => {
  // Built from the running platform's root so the expectation holds on
  // Windows ("C:\") as well as on POSIX ("/").
  const root = parse(Deno.cwd()).root;
  const folder = join(root, "Users", "me");
  assertEquals(breadcrumbs(folder), [
    { name: root, path: root },
    { name: "Users", path: join(root, "Users") },
    { name: "me", path: folder },
  ]);
  // The root is its own single step, and a trailing separator adds none.
  assertEquals(breadcrumbs(root), [{ name: root, path: root }]);
  assertEquals(breadcrumbs(`${folder}${sep}`).length, 3);
});
