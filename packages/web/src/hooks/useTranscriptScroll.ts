import { type RefObject, useCallback, useEffect, useRef } from "preact/compat";

/** The scroll contract of a transcript: stay pinned to the newest content
 * while the reader is at the bottom, never yank them back when they scroll up,
 * and force the jump once after a submit (the sent message arrives
 * asynchronously, so the intent is remembered until the content changes). */
export interface TranscriptScroll {
  scrollRef: RefObject<HTMLDivElement | null>;
  /** Call when a message is submitted. */
  pinOnNextContent: () => void;
}

export function useTranscriptScroll(): TranscriptScroll {
  const scrollRef = useRef<HTMLDivElement>(null);
  const userScrolledUp = useRef(false);
  const pendingSubmit = useRef(false);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const pin = () => {
      if (pendingSubmit.current) {
        pendingSubmit.current = false;
        el.scrollTop = el.scrollHeight;
        return;
      }
      if (!userScrolledUp.current) el.scrollTop = el.scrollHeight;
    };
    const onScroll = () => {
      userScrolledUp.current =
        el.scrollHeight - el.scrollTop - el.clientHeight >= 80;
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
  }, []);

  const pinOnNextContent = useCallback(() => {
    pendingSubmit.current = true;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  return { scrollRef, pinOnNextContent };
}
