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

/** A debounced writer: each call resets the timer, the last value wins, and
 * an unmount or flush cancels the pending run. */
export function useDebouncedWrite(
  write: (value: string) => Promise<void>,
  ms = 600,
): { schedule: (value: string) => void; flush: () => Promise<void> } {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pending = useRef<string | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const schedule = useCallback((value: string) => {
    pending.current = value;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const next = pending.current;
      pending.current = undefined;
      if (next !== undefined) void write(next);
    }, ms);
  }, [write, ms]);
  const flush = useCallback(async () => {
    clearTimeout(timer.current);
    const next = pending.current;
    pending.current = undefined;
    if (next !== undefined) await write(next);
  }, [write]);
  return { schedule, flush };
}
