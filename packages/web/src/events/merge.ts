/**
 * Merging a freshly read window into the items a client already holds.
 *
 * Two surfaces read their transcript one window at a time: a code-mode
 * session's messages and a stella conversation's entries. Their reducers
 * differ (a message carries tools and panels, an entry carries what the
 * conversation shows), but the merge is the same problem twice — and it was
 * written twice, in `events.ts` and `stella-state.ts`, with slightly
 * different bookkeeping (one mapped a key to its positions, the other to a
 * single index). A fix to one was a fix the other did not get.
 *
 * The problem: a resync (a reconnect, a revision probe that saw a gap, a tab
 * returning to the foreground) re-reads the NEWEST window. It overlaps what
 * the client has and may carry items the client lacks — the ones appended
 * since, and, when compaction spliced a checkpoint into the history, one in
 * the middle. Items are ordered by the transcript, so the window anchors on
 * the items with the same identity, and anything new goes in front of the
 * anchor it precedes; anything after the last anchor extends the end. The two
 * sides can still disagree on an item's place — a prompt steered into a
 * running turn is held where it was typed but stored after the turn it joined
 * — and an item the view already holds then keeps the view's position.
 *
 * A window that shares nothing means the client fell more than a page
 * behind (or was never in step): it is replaced wholesale. Keeping the old
 * items would leave an invisible gap in the middle, which is worse than
 * losing a scroll position.
 */

/** A view's loaded history plus the cursor for the window before it. */
export interface LoadedWindow<T> {
  /** Oldest first, as the transcript holds them. */
  items: T[];
  /** The cursor for the window before `items[0]`, or null at the
   * transcript's beginning (see the core's session/transcript-window.ts). */
  older: string | null;
}

/** How one surface identifies and orders its items. */
export interface MergeRules<T> {
  /** The identity of an item, for dedup and anchoring. */
  key: (item: T) => string;
  /**
   * Whether one identity may occupy more than one position. A transcript
   * that can hold a duplicated key (a corrupted history) needs every
   * occurrence matched in order, so a repeated identity does not pile every
   * incoming copy onto the last one. False for a history whose keys are
   * unique by construction.
   */
  multiAnchor?: boolean;
}

/** Fold the NEWEST window the server returned into the history a view holds.
 *
 * The cursor is not taken from either side: it stays the view's while the
 * view's front is unchanged, becomes the window's when the window reached
 * back before it, and is dropped when the front is an item neither side
 * named (the reader paged further than one window, and the next read of the
 * newest window restores a cursor that exists). */
export function mergeNewestWindow<T>(
  history: LoadedWindow<T>,
  window: LoadedWindow<T>,
  rules: MergeRules<T>,
): LoadedWindow<T> {
  const existing = history.items;
  const fetched = window.items;
  if (fetched.length === 0) return history;
  // Nothing loaded yet: the window IS the history, cursor included.
  if (existing.length === 0) return { items: fetched, older: window.older };

  const anchorsByKey = anchorsOf(existing, rules);
  if (!fetched.some((item) => anchorsByKey.has(rules.key(item)))) {
    // No overlap: the view is behind by a whole page or more, and keeping
    // its items would leave a hole between them and the window.
    return { items: fetched, older: window.older };
  }

  const merged: T[] = [];
  // Items the window carries that the view lacks: each goes in front of the
  // next item the view already has.
  let pending: T[] = [];
  let cursor = 0;
  for (const item of fetched) {
    const anchor = anchorsByKey.get(rules.key(item))?.shift();
    if (anchor === undefined) {
      pending.push(item);
      continue;
    }
    // An item the view holds earlier than the window places it (see above)
    // has already been written out; walking back to its anchor would emit
    // every row in between a second time — the duplicated turn a steered
    // prompt would otherwise leave behind.
    if (anchor < cursor) continue;
    while (cursor < anchor) {
      merged.push(existing[cursor]!);
      cursor++;
    }
    // The same identity is the same item: the persisted copy wins (a stream
    // can leave a placeholder behind).
    merged.push(...pending, item);
    pending = [];
    cursor = anchor + 1;
  }
  while (cursor < existing.length) {
    merged.push(existing[cursor]!);
    cursor++;
  }
  merged.push(...pending);

  return {
    items: merged,
    older: cursorAfterMerge(history, window, merged, rules),
  };
}

/** Where each identity sits in `items` (see MergeRules.multiAnchor). */
function anchorsOf<T>(
  items: readonly T[],
  rules: MergeRules<T>,
): Map<string, number[]> {
  const anchors = new Map<string, number[]>();
  items.forEach((item, index) => {
    const key = rules.key(item);
    const positions = anchors.get(key);
    if (positions === undefined) anchors.set(key, [index]);
    else if (rules.multiAnchor === true) positions.push(index);
    // Without multi-anchor the first occurrence is the only one a client can
    // hold: a later duplicate is history the merge replaces.
  });
  return anchors;
}

/** The cursor for the merged history (see mergeNewestWindow). */
function cursorAfterMerge<T>(
  history: LoadedWindow<T>,
  window: LoadedWindow<T>,
  merged: readonly T[],
  rules: MergeRules<T>,
): string | null {
  const front = merged[0];
  if (front === undefined) return null;
  const frontKey = rules.key(front);
  // The merge may keep either copy of a shared item (the window's wins), so
  // the front is compared by identity, not by object.
  const historyFront = history.items[0];
  if (historyFront !== undefined && rules.key(historyFront) === frontKey) {
    return history.older;
  }
  const inWindow = window.items.some((item) => rules.key(item) === frontKey);
  return inWindow ? window.older : null;
}

/** Put a page the reader asked for (the window before `older`) in front of
 * the history, and keep the cursor for the one before it.
 *
 * Paging is positional in effect but identity-based in fact: the server
 * answers with the window that ends just before the item the cursor names, so
 * a page never repeats itself and never skips. Items already loaded are
 * dropped (compaction can shift a page's boundary), and a page that adds
 * nothing ends the walk for good — the reader must not be sent round the same
 * window twice.
 *
 * "Already loaded" is per occurrence, not per identity: a page may
 * legitimately carry the same identity twice (a duplicated key in the
 * history), and dropping both because the view holds one would lose the
 * other. */
export function prependOlderWindow<T>(
  history: LoadedWindow<T>,
  page: readonly T[],
  nextOlder: string | null,
  rules: MergeRules<T>,
): LoadedWindow<T> {
  if (page.length === 0) return { items: history.items, older: null };
  const loaded = new Map<string, number>();
  for (const item of history.items) {
    const key = rules.key(item);
    loaded.set(key, (loaded.get(key) ?? 0) + 1);
  }
  const added: T[] = [];
  for (const item of page) {
    const key = rules.key(item);
    const remaining = loaded.get(key);
    if (remaining !== undefined && remaining > 0) {
      loaded.set(key, remaining - 1);
      continue;
    }
    added.push(item);
  }
  // A page that adds nothing ends the walk: the reader must not be sent
  // round the same window twice.
  if (added.length === 0) return { items: history.items, older: null };
  return { items: [...added, ...history.items], older: nextOlder };
}

/** Put a page the reader asked for in front of the history, taking only the
 * items that belong there.
 *
 * The page is asked for by cursor, but the cursor names a point in a
 * transcript that keeps growing: by the time the answer arrives, a run may
 * have appended items AFTER the cursor. Those are not this page's to insert.
 * Prepending everything the client lacks put a live reply at the TOP of the
 * conversation — and because the next live event then appended the same item
 * again, the conversation showed the message twice (a duplicate that a
 * reload removed, since the server holds it once).
 *
 * So only items that belong before what the client holds are taken: the page
 * stops at the first item the client already has, and an item newer than the
 * client's newest is left to the live stream. A page that adds nothing ends
 * the walk — the client must not be sent round the same window twice.
 *
 * `timestamp` is what orders the two: an item newer than the client's newest
 * belongs to the live edge, and the cursor names a point in time. */
export function prependHistoricWindow<T>(
  history: LoadedWindow<T>,
  page: readonly T[],
  nextOlder: string | null,
  rules: MergeRules<T> & { timestamp: (item: T) => number },
): LoadedWindow<T> {
  if (page.length === 0) return { ...history, older: null };
  const known = new Set(history.items.map(rules.key));
  const newest = history.items.at(-1);
  const newestAt = newest === undefined ? 0 : rules.timestamp(newest);
  const added: T[] = [];
  for (const item of page) {
    // The page has run into what the client holds: everything after this is
    // history the client already has, not the page before it.
    if (known.has(rules.key(item))) break;
    // An item the client does not hold but that is newer than its newest
    // belongs to the live edge, not above it.
    if (rules.timestamp(item) > newestAt) break;
    added.push(item);
  }
  if (added.length === 0) return { ...history, older: null };
  return { items: [...added, ...history.items], older: nextOlder };
}
