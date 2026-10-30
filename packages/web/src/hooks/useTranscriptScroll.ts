import {
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
} from "preact/compat";

/** The scroll contract of a transcript: stay pinned to the newest content
 * while the reader is at the bottom, never yank them back when they scroll up,
 * force the jump once after a submit (the sent message arrives
 * asynchronously, so the intent is remembered until the content changes), and
 * read the history before the loaded window when the reader reaches the top,
 * without moving the lines they are reading. */
export interface TranscriptScroll {
  scrollRef: RefObject<HTMLDivElement | null>;
  /** Call when a message is submitted. */
  pinOnNextContent: () => void;
}

export interface TranscriptScrollOptions {
  /** Ask for the history before the loaded window. Return true when a read
   * started (the reader's position is then held until it lands); false when
   * there is nothing more to read. */
  onReachTop?: () => boolean;
  /** Whether a read the hook asked for is still in flight. Reaching false
   * releases a held position even when the read added nothing. */
  loadingOlder?: boolean;
  /** Identity of the first message the transcript holds (see the web's
   * messageKey). A change means history was inserted above it. */
  firstMessageKey?: string;
  /** Bumped by the view when a message is submitted. The transcript that
   * OWNS the scroll element is the one that has to react, so the intent
   * travels as a prop instead of being called on the caller's own (empty)
   * hook instance: the composer's view has no scroll element, and calling
   * `pinOnNextContent` there set a flag on a ref nobody read. */
  pinToken?: number;
}

/** Distance from the top (px) at which the previous window is requested. */
const OLDER_DISTANCE = 48;

/** How far from the bottom still counts as following the newest content. */
const STICK_DISTANCE = 80;

/**
 * The scroll contract of one transcript.
 *
 * The transcript holds a WINDOW of the session's history (see the core's
 * session/transcript-window.ts), so the reader reaches a point where what they
 * want is not loaded: the window before the loaded one has to be read when the
 * top comes into view. Reading it inserts content above the reader, which
 * would otherwise shift every line they are looking at; the held position
 * compensates by the height the transcript gained.
 */
export function useTranscriptScroll(
  options: TranscriptScrollOptions = {},
): TranscriptScroll {
  const scrollRef = useRef<HTMLDivElement>(null);
  const userScrolledUp = useRef(false);
  const pendingSubmit = useRef(false);
  /** Where the reader was when an older window was requested, with the first
   * message the transcript held at that moment. */
  const anchor = useRef<
    { height: number; top: number; key: string | undefined } | null
  >(null);
  /** A read is in flight for the held position: the follow-to-bottom must not
   * undo it, and a second reach for the top must not start another. */
  const holding = useRef(false);

  // The latest callbacks and keys, so the listeners are installed once and can
  // never call a stale closure (a page may be in flight while the reader keeps
  // scrolling).
  const onReachTopRef = useRef(options.onReachTop);
  onReachTopRef.current = options.onReachTop;
  const firstKeyRef = useRef(options.firstMessageKey);
  firstKeyRef.current = options.firstMessageKey;

  /** Ask for the window before the loaded one, holding the reader's place.
   * Returns whether a read started. */
  const reachTop = useCallback((el: HTMLDivElement): boolean => {
    if (holding.current) return true;
    const started = onReachTopRef.current?.() === true;
    if (!started) return false;
    holding.current = true;
    anchor.current = {
      height: el.scrollHeight,
      top: el.scrollTop,
      key: firstKeyRef.current,
    };
    return true;
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const pin = () => {
      if (pendingSubmit.current) {
        pendingSubmit.current = false;
        el.scrollTop = el.scrollHeight;
        return;
      }
      // A held position belongs to a page that is landing: the content it
      // adds must not push the reader to the bottom.
      if (holding.current) return;
      if (!userScrolledUp.current) el.scrollTop = el.scrollHeight;
    };
    const onScroll = () => {
      userScrolledUp.current =
        el.scrollHeight - el.scrollTop - el.clientHeight >= STICK_DISTANCE;
      // Not at the top: nothing to read before, and the position the reader
      // is at now is the one worth keeping.
      if (el.scrollTop > OLDER_DISTANCE) return;
      reachTop(el);
    };
    pin();
    el.addEventListener("scroll", onScroll, { passive: true });
    // A ResizeObserver fires on every layout change (streaming deltas, tool
    // state, images, error rows), so the follow needs no list of sources.
    const observer = new ResizeObserver(pin);
    observer.observe(el);
    const content = el.firstElementChild;
    if (content) observer.observe(content);
    return () => {
      el.removeEventListener("scroll", onScroll);
      observer.disconnect();
    };
  }, [reachTop]);

  // A window shorter than the transcript shows no scrollbar, so no scroll
  // event can ask for the page that would fill it. Read until the transcript
  // overflows (or the history ends), one page per landing.
  const firstKey = options.firstMessageKey;
  const loadingOlder = options.loadingOlder === true;
  useEffect(() => {
    if (loadingOlder) return;
    const el = scrollRef.current;
    if (!el || el.scrollHeight > el.clientHeight + 1) return;
    reachTop(el);
  }, [firstKey, loadingOlder, reachTop]);

  // The reader's position survives content inserted above it: the transcript
  // grew by (height now - height then), so adding that to the old offset keeps
  // the same line under the pointer. Runs after the DOM was updated (a layout
  // effect) and before the browser paints the new height.
  useLayoutEffect(() => {
    const held = anchor.current;
    const el = scrollRef.current;
    if (held === null || el === null) return;
    // Nothing was inserted (the history's beginning, a failed read): release
    // the position so scrolling behaves normally again.
    if (held.key === firstKey) {
      if (!loadingOlder) {
        anchor.current = null;
        holding.current = false;
      }
      return;
    }
    anchor.current = null;
    holding.current = false;
    // The reader left the top while the page was in flight: their position is
    // the one to keep, and it is already where they put it.
    if (held.top > OLDER_DISTANCE) return;
    el.scrollTop = held.top + (el.scrollHeight - held.height);
  }, [firstKey, loadingOlder]);

  /** Force the next content change to scroll to the bottom. The hook's own
   * view can call it; a parent that does not own the element passes
   * `pinToken` instead (see TranscriptScrollOptions.pinToken). */
  const pinOnNextContent = useCallback(() => {
    pendingSubmit.current = true;
    holding.current = false;
    anchor.current = null;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  // The parent's submit: pin once per token value. Tracked in a ref so the
  // effect does not re-run for the token alone (the pin itself is a one-shot
  // intent, not a re-render trigger).
  const lastPinToken = useRef(options.pinToken);
  useEffect(() => {
    if (options.pinToken === undefined) return;
    if (lastPinToken.current === options.pinToken) return;
    lastPinToken.current = options.pinToken;
    pinOnNextContent();
  }, [options.pinToken, pinOnNextContent]);

  return { scrollRef, pinOnNextContent };
}
