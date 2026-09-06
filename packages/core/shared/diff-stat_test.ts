import { assertEquals } from "@std/assert";
import { diffLineCounts, formatDiffStat, splitDiffLines } from "./diff-stat.ts";

Deno.test("splitDiffLines handles empty, trailing newline and CRLF", () => {
  assertEquals(splitDiffLines(""), []);
  assertEquals(splitDiffLines("a"), ["a"]);
  assertEquals(splitDiffLines("a\nb"), ["a", "b"]);
  assertEquals(splitDiffLines("a\nb\n"), ["a", "b"]);
  assertEquals(splitDiffLines("a\r\nb\r\n"), ["a", "b"]);
});

Deno.test("diffLineCounts counts a full block replacement", () => {
  assertEquals(
    diffLineCounts("a\nb\nc\nd\ne", "1\n2\n3\n4\n5\n6\n7\n8\n9\n10"),
    { addedLines: 10, removedLines: 5 },
  );
});

Deno.test("diffLineCounts trims common prefix/suffix lines", () => {
  // One changed line inside a 3-line block reports +1 -1, not +3 -3.
  assertEquals(
    diffLineCounts("one\ntwo\nthree", "one\nTWO\nthree"),
    { addedLines: 1, removedLines: 1 },
  );
});

Deno.test("diffLineCounts handles pure additions and deletions", () => {
  assertEquals(diffLineCounts("a", "a\nb"), { addedLines: 1, removedLines: 0 });
  assertEquals(diffLineCounts("a\nb", "a"), { addedLines: 0, removedLines: 1 });
  assertEquals(diffLineCounts("", "a\nb\n"), {
    addedLines: 2,
    removedLines: 0,
  });
});

Deno.test("diffLineCounts is zero for identical text across line endings", () => {
  assertEquals(diffLineCounts("a\nb\n", "a\nb\n"), {
    addedLines: 0,
    removedLines: 0,
  });
  assertEquals(diffLineCounts("a\r\nb\r\n", "a\nb\n"), {
    addedLines: 0,
    removedLines: 0,
  });
});

Deno.test("formatDiffStat renders +A -R, omitting zero sides", () => {
  assertEquals(formatDiffStat(10, 5), "+10 -5");
  assertEquals(formatDiffStat(3, 0), "+3");
  assertEquals(formatDiffStat(0, 2), "-2");
  assertEquals(formatDiffStat(0, 0), "");
});
