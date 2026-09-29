import { assertEquals } from "@std/assert";
import { join, parse, sep } from "node:path";
import { breadcrumbs, buildPlaces, placeCandidates } from "./fs.ts";

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
