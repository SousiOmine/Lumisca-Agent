/**
 * The rule that tells a page its client bundle has been replaced.
 *
 * The cases worth pinning are the ones that must NOT read as a change: a
 * server that predates the build id, and a page that never received one. Both
 * answer "cannot tell", and treating either as stale would make every reload
 * of an older install offer a reload that changes nothing.
 */
import { assertEquals } from "@std/assert";
import { buildMoved } from "./useBuildWatch.ts";

Deno.test("buildMoved: a different build is a move", () => {
  assertEquals(buildMoved('W/"abc"', 'W/"def"'), true);
});

Deno.test("buildMoved: the same build is not", () => {
  assertEquals(buildMoved('W/"abc"', 'W/"abc"'), false);
});

Deno.test("buildMoved: a missing value on either side is not a move", () => {
  // A server that predates the field reports nothing to compare.
  assertEquals(buildMoved('W/"abc"', undefined), false);
  // A page whose own build id never arrived (an older server's page).
  assertEquals(buildMoved(undefined, 'W/"abc"'), false);
  assertEquals(buildMoved(undefined, undefined), false);
  assertEquals(buildMoved("", 'W/"abc"'), false);
  assertEquals(buildMoved('W/"abc"', ""), false);
});
