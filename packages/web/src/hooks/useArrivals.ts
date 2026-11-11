import { useEffect, useRef, useState } from "preact/compat";

/**
 * Which rows of a list are genuinely NEW, so an entrance animation can run
 * for them and only for them.
 *
 * A transcript renders its whole loaded window on the first paint, and
 * paging back inserts a page of older rows above what the reader is looking
 * at (see hooks/useTranscriptScroll.ts). An unconditional `animation` on
 * every row therefore means the first render stages a hundred messages in
 * sequence and the page read back flashes under the reader's eyes. The
 * animation is not wrong — it is answering the wrong question ("did this
 * render?") instead of the right one ("did this just arrive?").
 *
 * The answer is the diff against the previous render: rows appended at the
 * END since the last commit. A page of history arrives at the FRONT and
 * therefore reports nothing. A window that replaced the whole list (a resync
 * that fell behind by more than a page, a conversation switch) reports
 * nothing either: every row is new there, and animating all of them is
 * exactly the staging this exists to prevent.
 */

/**
 * The most rows one commit can add and still count as "live". A reply and the
 * user's own message land one at a time; several at once is a load (a
 * snapshot, a resync, a rewind) that happened to land between two commits,
 * and staging it would be the flash this file exists to avoid.
 */
export const MAX_ARRIVALS = 3;

/** Keys appended at the live edge since `previous`. Empty when the list
 * arrived whole, was replaced, shrank, or grew by a batch. */
export function newArrivals(
  previous: readonly string[] | undefined,
  current: readonly string[],
): string[] {
  // The first render of a list is not an arrival: the whole history is new
  // to the DOM but none of it just happened.
  if (previous === undefined) return [];
  if (current.length <= previous.length) return [];
  // Only the tail can be new. Find the last previous key inside the current
  // list: everything after it was appended. With no previous rows (an empty
  // list that just got its first entries) the same rule holds against no
  // anchor, and the batch cap decides.
  const last = previous[previous.length - 1];
  const at = last === undefined ? -1 : current.lastIndexOf(last);
  // The anchor is gone (a rewind deleted the tail, a page replaced the list):
  // the rows are a new list, not continuations of the old one.
  if (last !== undefined && at === -1) return [];
  const added = current.slice(at + 1);
  return added.length <= MAX_ARRIVALS ? added : [];
}

/** How long an arrival keeps its `data-enter` attribute. The animation is
 * `both`-filled and one-shot, so the attribute only has to outlive the
 * animation itself; leaving it on would make the next re-render restart it
 * (the element would keep matching `[data-enter]`). Comfortably above the
 * longest entrance (< 300ms). */
export const ARRIVAL_FLAG_MS = 400;

/** The "nothing arrived" answer. One instance, so a timeout can put the state
 * back without re-rendering a list that has not changed. */
const NONE: ReadonlySet<string> = new Set();

/**
 * Whether a row that just settled is the text the reader was already watching
 * arrive.
 *
 * A streaming reply and its finished message are two different elements: the
 * first is the live tail, the second is the entry the server then sends. If
 * the finished one counted as an arrival, every reply would replay once it
 * finished — the words jump back to their start and rise into place after the
 * reader has read them. The text is the identity here: the streamed body is a
 * prefix of the settled one (the server sends the complete message).
 *
 * Compared with the ends trimmed, because the server may keep a trailing
 * newline the stream never produced and the other way round.
 */
export function isStreamHandoff(streamed: string, settled: string): boolean {
  const from = streamed.trim();
  const to = settled.trim();
  if (from.length === 0 || to.length === 0) return false;
  return to.startsWith(from) || from.startsWith(to);
}

/** Drop the arrival that is really the stream's own text settling. Returns
 * the same set when nothing is dropped (a set per commit would invalidate
 * the memoized rows). */
export function withoutHandoff(
  arrivals: ReadonlySet<string>,
  /** The rows in order, same keys as the arrival set holds. */
  rows: readonly { key: string; text: string }[],
  streamed: string,
): ReadonlySet<string> {
  if (arrivals.size === 0) return arrivals;
  let dropped: string | null = null;
  for (const row of rows) {
    if (arrivals.has(row.key) && isStreamHandoff(streamed, row.text)) {
      dropped = row.key;
      break;
    }
  }
  if (dropped === null) return arrivals;
  const next = new Set(arrivals);
  next.delete(dropped);
  return next.size === 0 ? NONE : next;
}

/**
 * The keys that just arrived at the live edge of a list, and that should
 * therefore animate once.
 *
 * Call with the identity of every row, in order. The returned set holds the
 * keys appended by the latest commit; they leave it {@link ARRIVAL_FLAG_MS}
 * later, so an unrelated re-render (a language switch, a scroll) cannot
 * restart the animation.
 *
 * A transcript re-renders on every streamed token, so the set keeps its
 * identity when nothing arrived: the caller can put it in a dependency list
 * without invalidating every memoized row per token.
 */
export function useArrivals(keys: readonly string[]): ReadonlySet<string> {
  const previous = useRef<readonly string[] | undefined>(undefined);
  const latest = useRef(keys);
  latest.current = keys;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [flagged, setFlagged] = useState<ReadonlySet<string>>(NONE);
  // The identity of the list's contents: the array is rebuilt on every render
  // (and a streamed token re-renders the whole transcript), so depending on
  // it directly would run the diff per token.
  const joined = keys.join("\u0000");

  useEffect(() => {
    const current = latest.current;
    const arrivals = newArrivals(previous.current, current);
    previous.current = current;
    if (arrivals.length === 0) return;
    if (timer.current !== null) clearTimeout(timer.current);
    setFlagged(new Set(arrivals));
    timer.current = setTimeout(() => {
      timer.current = null;
      setFlagged(NONE);
    }, ARRIVAL_FLAG_MS);
  }, [joined]);

  // A list that unmounts mid-animation leaves no timer behind.
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  return flagged;
}
