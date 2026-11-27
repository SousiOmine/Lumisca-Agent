import { test } from "bun:test";
import { assertEquals } from "@std/assert";
import {
  grantOwning,
  isShareName,
  isSharePath,
  isWithinShare,
  parseGrant,
  relativeSegments,
  SHARE_ROOT,
  shareNameFrom,
  sharePathOf,
  shareRootOf,
} from "./grant.ts";
import { sharesOf } from "./registry.ts";
import { grantOf } from "./test-utils.ts";

test("a lent folder's name is a path segment", () => {
  assertEquals(shareNameFrom("/Users/me/My Project", []), "my-project");
  assertEquals(shareNameFrom("C:\\Users\\me\\Proj", []), "proj");
  assertEquals(shareNameFrom("/Users/me/proj/", []), "proj");
  // Nothing usable survives: the namespace still needs a name.
  assertEquals(shareNameFrom("/", []), "folder");
  assertEquals(shareNameFrom("/Users/me/資料", []), "folder");
  assertEquals(isShareName("my-project"), true);
  assertEquals(isShareName("My Project"), false);
  assertEquals(isShareName("-proj"), false);
  assertEquals(isShareName(""), false);
});

test("a duplicate name takes the lowest free suffix", () => {
  assertEquals(shareNameFrom("/a/proj", ["proj"]), "proj-2");
  assertEquals(shareNameFrom("/b/proj", ["proj", "proj-2"]), "proj-3");
  // The suffix fits the length cap by shortening the name, not by growing it.
  const long = "a".repeat(32);
  assertEquals(shareNameFrom(`/x/${long}`, [long]), `${"a".repeat(30)}-2`);
});

test("the namespace is containment-checked in POSIX terms", () => {
  assertEquals(isSharePath(SHARE_ROOT), true);
  assertEquals(isSharePath(`${SHARE_ROOT}/proj/x`), true);
  assertEquals(isSharePath("/lendish/x"), false);
  assertEquals(isWithinShare(shareRootOf("proj"), shareRootOf("proj")), true);
  assertEquals(
    isWithinShare(shareRootOf("proj"), `${SHARE_ROOT}/proj/a`),
    true,
  );
  assertEquals(
    isWithinShare(shareRootOf("proj"), `${SHARE_ROOT}/proj2/a`),
    false,
  );
});

test("a grant-relative path is segments, and escapes are refused", () => {
  const root = shareRootOf("proj");
  assertEquals(relativeSegments(root, root), []);
  assertEquals(relativeSegments(root, `${root}/src/a.ts`), ["src", "a.ts"]);
  assertEquals(relativeSegments(root, `${SHARE_ROOT}/other/a`), undefined);
  assertEquals(relativeSegments(root, "/etc/passwd"), undefined);
  // A `..` that climbs out of the grant is not a path inside it.
  assertEquals(relativeSegments(root, `${root}/../other`), undefined);
});

test("a path built from segments cannot climb out", () => {
  const root = shareRootOf("proj");
  assertEquals(sharePathOf(root, ["src", "a.ts"]), `${root}/src/a.ts`);
  assertEquals(sharePathOf(root, ["..", "other", "a"]), undefined);
  assertEquals(sharePathOf(root, ["src", "..", "..", "a"]), undefined);
});

test("the longest matching grant owns a path", () => {
  const short = grantOf({ id: "a", name: "proj" });
  const long = grantOf({ id: "b", name: "proj-src" });
  const grants = [short, long];
  assertEquals(grantOwning(grants, shareRootOf("proj"))?.id, "a");
  assertEquals(grantOwning(grants, `${shareRootOf("proj")}/x`)?.id, "a");
  assertEquals(grantOwning(grants, `${shareRootOf("proj-src")}/x`)?.id, "b");
  assertEquals(grantOwning(grants, shareRootOf("other")), undefined);
  // Not a path-prefix match: "proj-2" is a different folder, not a child.
  assertEquals(grantOwning(grants, `${SHARE_ROOT}/proj2/x`), undefined);
});

test("an announcement may carry no deadline", () => {
  const wire = {
    id: "g1",
    sessionId: "s1",
    name: "proj",
    path: "/Users/me/proj",
    write: true,
    expiresAt: null,
    host: { platform: "macos", name: "mac", shell: "zsh" },
  };
  assertEquals(parseGrant(wire)?.expiresAt, null);
  // The field is still required: an app that never says when its loan ends is
  // not the same app as one that says it never ends.
  const { expiresAt: _omitted, ...withoutDeadline } = wire;
  assertEquals(parseGrant(withoutDeadline), undefined);
});

test("a grant carries the loan it belongs to", () => {
  const wire = {
    id: "g1",
    sessionId: "s1",
    name: "c",
    path: "C:\\",
    write: false,
    expiresAt: null,
    host: { platform: "windows", name: "pc", shell: "pwsh" },
  };
  // A folder lent on its own has no group; the places of one computer loan
  // share one, and it travels to the client unchanged.
  assertEquals(parseGrant(wire)?.group, undefined);
  const grouped = parseGrant({ ...wire, group: "pc-1" });
  assertEquals(grouped?.group, "pc-1");
  // The client draws the list from the same object: the group must survive
  // the copy the server sends, or the loan would draw as two folders.
  assertEquals(
    grouped === undefined ? undefined : sharesOf([grouped])[0]?.group,
    "pc-1",
  );
  // A group that is not a string is a different shape, not a name.
  assertEquals(parseGrant({ ...wire, group: 4 }), undefined);
});
