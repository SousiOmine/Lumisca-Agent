import { useCallback, useEffect, useRef, useState } from "preact/hooks";

/** True while a save is in flight. */
export interface SaveState {
  saving: boolean;
  error: string | undefined;
}

/** A clipboard copy that reports "copied" for a moment. Browsers without
 * the clipboard API (or a denied permission) stay silent: the text is still
 * selectable. */
export function useCopy(
  text: string,
  ms = 1500,
): {
  copied: boolean;
  copy: () => Promise<void>;
} {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), ms);
    } catch {
      // Clipboard unavailable.
    }
  }, [text, ms]);
  return { copied, copy };
}

/** A short-lived "saved" flag for a form that persists on its own (an
 * optimistic toggle, a debounced field). */
export function useSavedNotice(ms = 2000): {
  saved: boolean;
  flash: () => void;
} {
  const [saved, setSaved] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const flash = useCallback(() => {
    setSaved(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setSaved(false), ms);
  }, [ms]);
  return { saved, flash };
}

/** Persist one thing with a busy flag and an error line, restoring the UI
 * value when the write is rejected (the field then never shows something
 * that was not stored). */
export function useSaveAction(formatError: (error: unknown) => string): {
  saving: boolean;
  error: string | undefined;
  /** Run `write`; on failure `restore` runs and `error` is set. */
  save: (
    write: () => Promise<unknown>,
    restore?: () => void,
  ) => Promise<boolean>;
  /** Record a failure that did not go through `save` (a failed load). */
  fail: (error: unknown) => void;
  clearError: () => void;
} {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const save = useCallback(
    async (write: () => Promise<unknown>, restore?: () => void) => {
      setSaving(true);
      setError(undefined);
      try {
        await write();
        return true;
      } catch (e) {
        restore?.();
        setError(formatError(e));
        return false;
      } finally {
        setSaving(false);
      }
    },
    [formatError],
  );
  const fail = useCallback(
    (cause: unknown) => setError(formatError(cause)),
    [formatError],
  );
  const clearError = useCallback(() => setError(undefined), []);
  return { saving, error, save, fail, clearError };
}

/** The quiet period a form waits before it persists what the user typed.
 * One value so every "saves while you type" field feels the same. */
export const SAVE_DEBOUNCE_MS = 600;

/**
 * The timer and the pending value of {@link useDebouncedWrite}, kept outside
 * the hook so a test can drive it with a real clock and call {@link
 * DebouncedWriter.dispose} where a component would unmount.
 *
 * `T` is whatever the write needs (the text of one field, or an object
 * naming which setting it is): the timer is about WHEN to write, not what.
 */
export function createDebouncedWriter<T>(
  write: (value: T) => void | Promise<void>,
  ms: number,
): DebouncedWriter<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: { value: T } | undefined;
  let latestWrite = write;
  let delay = ms;
  /** Take the queued value and stop the timer. */
  const settle = (): { value: T } | undefined => {
    clearTimeout(timer);
    timer = undefined;
    const next = pending;
    pending = undefined;
    return next;
  };
  return {
    schedule(value) {
      pending = { value };
      clearTimeout(timer);
      timer = setTimeout(() => {
        const next = settle();
        if (next !== undefined) void latestWrite(next.value);
      }, delay);
    },
    async flush() {
      const next = settle();
      if (next !== undefined) await latestWrite(next.value);
    },
    cancel() {
      settle();
    },
    dispose() {
      const next = settle();
      if (next !== undefined) void latestWrite(next.value);
    },
    setWrite(next) {
      latestWrite = next;
    },
    setMs(next) {
      delay = next;
    },
  };
}

/**
 * A debounced writer: each call resets the timer, the last value wins, and a
 * flush, an explicit dispose, or the component unmounting settles the
 * pending run.
 *
 * Callers that must persist immediately (a blur, Enter) call `flush`. The
 * unmount path writes what was typed rather than dropping it: a dialog
 * closed with the caret still in the box has to keep its text, and the
 * pending value is exactly the text the user stopped typing on.
 */
export function useDebouncedWrite<T>(
  write: (value: T) => void | Promise<void>,
  ms = SAVE_DEBOUNCE_MS,
): DebouncedWriter<T> {
  const writer = useRef<DebouncedWriter<T> | undefined>(undefined);
  if (writer.current === undefined) {
    writer.current = createDebouncedWriter(write, ms);
  }
  const current = writer.current;
  // The write callback is usually an inline closure over the render's state;
  // handing it over on every render keeps the timer callback current without
  // restarting the timer. The delay is kept current the same way.
  useEffect(() => {
    current.setWrite(write);
    current.setMs(ms);
  });
  useEffect(() => () => current.dispose(), [current]);
  return current;
}

/** What {@link useDebouncedWrite} returns. */
export interface DebouncedWriter<T> {
  /** Queue `value`; the previous queued value is dropped. */
  schedule: (value: T) => void;
  /** Write the queued value now (no-op when nothing is queued). */
  flush: () => Promise<void>;
  /** Drop the queued value without writing. */
  cancel: () => void;
  /** Write the queued value now and stop the timer. The hook calls this on
   * unmount so a closed panel keeps what was typed. */
  dispose: () => void;
  /** Replace the write callback. */
  setWrite: (write: (value: T) => void | Promise<void>) => void;
  /** Replace the debounce delay. */
  setMs: (ms: number) => void;
}
