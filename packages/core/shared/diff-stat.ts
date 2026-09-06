/** Frontend-safe shared helpers (see shared/mod.ts): pure functions and constants with no runtime dependencies (no db / pi imports), bundled into the browser client. */

/** Added/removed line counts of one file change, as shown in the UI. */
export interface DiffLineCounts {
  addedLines: number;
  removedLines: number;
}

/** Split text into lines for diff counting: CRLF normalizes to LF, a
 * trailing newline does not create an extra line, and the empty string has
 * zero lines. */
export function splitDiffLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Count how many lines `newText` adds and `oldText` removes. Identical
 * leading/trailing lines cancel out, so a one-line change inside a larger
 * replaced block reports `+1 -1` instead of the block size. */
export function diffLineCounts(
  oldText: string,
  newText: string,
): DiffLineCounts {
  const oldLines = splitDiffLines(oldText);
  const newLines = splitDiffLines(newText);
  let start = 0;
  while (
    start < oldLines.length && start < newLines.length &&
    oldLines[start] === newLines[start]
  ) {
    start++;
  }
  let endOld = oldLines.length - 1;
  let endNew = newLines.length - 1;
  while (
    endOld >= start && endNew >= start &&
    oldLines[endOld] === newLines[endNew]
  ) {
    endOld--;
    endNew--;
  }
  return {
    addedLines: endNew - start + 1,
    removedLines: endOld - start + 1,
  };
}

/** Format counts as a diff stat (`+10 -5`): one side is omitted when it is
 * zero, and both zero renders as "". */
export function formatDiffStat(added: number, removed: number): string {
  if (added > 0 && removed > 0) return `+${added} -${removed}`;
  if (added > 0) return `+${added}`;
  if (removed > 0) return `-${removed}`;
  return "";
}
