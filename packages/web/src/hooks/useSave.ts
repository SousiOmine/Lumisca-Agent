import { useCallback, useEffect, useRef, useState } from "preact/compat";

/** True while a save is in flight. */
export interface SaveState {
  saving: boolean;
  error: string | undefined;
}

/** A clipboard copy that reports "copied" for a moment. Browsers without
 * the clipboard API (or a denied permission) stay silent: the text is still
 * selectable. */
export function useCopy(text: string, ms = 1500): {
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
 * A debounced writer: each call resets the timer, the last value wins, and an
 * unmount or {@link DebouncedWriter.flush} settles the pending run.
 *
 * `T` is whatever the write needs (the text of one field, or an object
 * naming which setting it is): the timer is about WHEN to write, not what.
 * Callers that must persist immediately (a blur, Enter) call `flush`; a
 * caller that is being torn down relies on the unmount cancel, which is why
 * the cleanup lives in the hook rather than in every panel.
 */
export function useDebouncedWrite<T>(
  write: (value: T) => void | Promise<void>,
  ms = SAVE_DEBOUNCE_MS,
): DebouncedWriter<T> {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pending = useRef<{ value: T } | undefined>(undefined);
  // The write callback is usually an inline closure over the render's state;
  // holding it in a ref keeps the timer callback current without restarting
  // the timer on every render.
  const latestWrite = useRef(write);
  useEffect(() => {
    latestWrite.current = write;
  });
  useEffect(() => () => clearTimeout(timer.current), []);
  const schedule = useCallback((value: T) => {
    pending.current = { value };
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const next = pending.current;
      pending.current = undefined;
      if (next !== undefined) void latestWrite.current(next.value);
    }, ms);
  }, [ms]);
  const flush = useCallback(async () => {
    clearTimeout(timer.current);
    const next = pending.current;
    pending.current = undefined;
    if (next !== undefined) await latestWrite.current(next.value);
  }, []);
  const cancel = useCallback(() => {
    clearTimeout(timer.current);
    pending.current = undefined;
  }, []);
  return { schedule, flush, cancel };
}

/** What {@link useDebouncedWrite} returns. */
export interface DebouncedWriter<T> {
  /** Queue `value`; the previous queued value is dropped. */
  schedule: (value: T) => void;
  /** Write the queued value now (no-op when nothing is queued). */
  flush: () => Promise<void>;
  /** Drop the queued value without writing. */
  cancel: () => void;
}
