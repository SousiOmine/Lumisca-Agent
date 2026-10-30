import { assertEquals } from "@std/assert";
import { diffLineCounts, formatDiffStat, splitDiffLines } from "./diff-stat.ts";

/** A diff stat is a display number: what matters is that it counts the way
 * the file tool's `details` promises (unchanged lines are not charged) and
 * that the edge bands stay distinct. Both are checked here, one test per
 * function, with the cases that a rewrite actually breaks spelled out. */

Deno.test("splitDiffLines drops the trailing break and normalizes CRLF", () => {
  // The line splitter feeds the counter, so a stray empty last line or a
  // leftover CR would show up as a phantom +1 on every edit of a CRLF file.
  assertEquals(splitDiffLines(""), []);
  assertEquals(splitDiffLines("a"), ["a"]);
  assertEquals(splitDiffLines("a\nb"), ["a", "b"]);
  assertEquals(splitDiffLines("a\nb\n"), ["a", "b"]);
  assertEquals(splitDiffLines("a\r\nb\r\n"), ["a", "b"]);
});

Deno.test("diffLineCounts charges only the lines that changed", () => {
  // Untouched prefix and suffix lines are not counted: one changed line in
  // a 3-line block is +1 -1, not +3 -3.
  assertEquals(
    diffLineCounts("one\ntwo\nthree", "one\nTWO\nthree"),
    { addedLines: 1, removedLines: 1 },
  );
  // A block that shares nothing is counted whole.
  assertEquals(
    diffLineCounts("a\nb\nc\nd\ne", "1\n2\n3\n4\n5\n6\n7\n8\n9\n10"),
    { addedLines: 10, removedLines: 5 },
  );
  // A pure append or truncation, including from and to an empty file.
  assertEquals(diffLineCounts("a", "a\nb"), { addedLines: 1, removedLines: 0 });
  assertEquals(diffLineCounts("a\nb", "a"), { addedLines: 0, removedLines: 1 });
  assertEquals(diffLineCounts("", "a\nb\n"), {
    addedLines: 2,
    removedLines: 0,
  });
  // The same text in different line endings is not a change at all.
  assertEquals(diffLineCounts("a\r\nb\r\n", "a\nb\n"), {
    addedLines: 0,
    removedLines: 0,
  });
});

Deno.test("formatDiffStat renders +A -R, omitting zero sides", () => {
  assertEquals(formatDiffStat(10, 5), "+10 -5");
  assertEquals(formatDiffStat(3, 0), "+3");
  assertEquals(formatDiffStat(0, 2), "-2");
  // Nothing changed: no stat at all, rather than a bare "+0".
  assertEquals(formatDiffStat(0, 0), "");
});
