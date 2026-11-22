import { test } from "bun:test";
import { assertEquals } from "@std/assert";
import {
  isWithin,
  isWithinPosix,
  isWithinRealpath,
  isWithinWith,
  toPosix,
} from "./path-util.ts";

/**
 * The one containment rule, and the named wrappers that read it.
 *
 * Every boundary in the app — the workspace sandbox, the VM's home, a lent
 * folder's namespace, a skill directory — is the same prefix question with
 * different comparison rules. These tests pin the rule (a sibling with a
 * shared prefix is NOT inside) and that each named form differs only in its
 * options, so a boundary cannot drift from its namesake.
 */

test("isWithinWith is root-or-below, never a shared prefix", () => {
  assertEquals(isWithinWith("/a/b", "/a/b"), true);
  assertEquals(isWithinWith("/a/b", "/a/b/c"), true);
  assertEquals(isWithinWith("/a/b", "/a/bc"), false);
  assertEquals(isWithinWith("/a/b", "/a"), false);
  // A trailing separator on the root does not double the one it adds.
  assertEquals(isWithinWith("/a/b/", "/a/b/c"), true);
});

test("isWithinWith folds case only when asked", () => {
  assertEquals(isWithinWith("/A/b", "/a/b/c"), false);
  assertEquals(isWithinWith("/A/b", "/a/b/c", { caseInsensitive: true }), true);
});

test("isWithinWith compares POSIX paths without host normalization", () => {
  // A backslash is a separator on the host and a character in the container,
  // so a POSIX comparison must not fold it.
  assertEquals(isWithinPosix("/a", "/a\\b"), false);
  assertEquals(isWithinWith("/a", "/a\\b"), true);
});

test("the named wrappers differ from isWithinWith only in their options", () => {
  assertEquals(isWithinPosix("/a/b", "/a/b/c"), true);
  assertEquals(isWithinPosix("/a/b", "/a/bc"), false);
  // The host form is the default rules, whatever the platform folds.
  assertEquals(isWithin("/a/b", "/a/b/c"), isWithinWith("/a/b", "/a/b/c"));
});

test("isWithinRealpath counts an unresolvable path as inside", () => {
  // The lexical check runs first; this one only guards a symlinked root, and
  // a target that does not exist yet must not be refused.
  assertEquals(
    isWithinRealpath("/nonexistent-root", "/nonexistent-root/x"),
    true,
  );
});

test("toPosix converts the host's separators", () => {
  assertEquals(toPosix("a\\b\\c"), "a/b/c");
  assertEquals(toPosix("a/b"), "a/b");
});
