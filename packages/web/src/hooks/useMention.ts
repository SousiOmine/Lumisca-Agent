import {
  type Dispatch,
  type KeyboardEvent,
  type RefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { api, fed } from "../api.ts";
import type { WorkspaceFileEntry } from "../types.ts";

/** An active `@` mention: the caret is inside a query started by `@`. */
export interface MentionState {
  /** Index of the `@` character in the input. */
  start: number;
  query: string;
  items: WorkspaceFileEntry[];
  active: number;
  loading: boolean;
}

/** Find the `@query` under the caret. `@` must start a word (preceded by
 * whitespace or a non-word character such as punctuation — Japanese text
 * counts), so emails like `foo@bar` never trigger. */
function detectMention(
  value: string,
  caret: number,
): { start: number; query: string } | null {
  const before = value.slice(0, caret);
  const match = /(^|[^\w])@([^\s]*)$/.exec(before);
  if (!match || match[1] === undefined) return null;
  return { start: match.index + match[1].length, query: match[2] ?? "" };
}

/** `@` file-suggestion state: detection under the caret, debounced fetch
 * of the workspace tree, and the candidate popover state. The caret marker
 * that positions the popover is owned by useCaretPosition; `clearCaret`
 * is invoked whenever the mention closes so no stale position lingers. */
export function useMention(options: {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  /** Workspace to offer files from; undefined disables mentions. */
  workspaceId?: string;
  /** Peer owning the workspace ("" = this server); suggestions come from
   * that machine. */
  peerId?: string;
  /** The current input value, for building the text after a pick. */
  value: string;
  onChange: (value: string) => void;
  /** Clear the caret marker (owned by useCaretPosition). */
  clearCaret: () => void;
}): {
  mention: MentionState | null;
  setMention: Dispatch<SetStateAction<MentionState | null>>;
  /** Re-evaluate the mention under the caret after typing or caret moves.
   * Returns true when a mention is now active. */
  updateMention: (nextValue: string, caret: number) => boolean;
  /** Replace `@query` with the picked path (plus a trailing space) and
   * focus the caret after it. */
  selectMention: (index: number) => void;
  /** Close the mention popover (and its caret marker). */
  closeMention: () => void;
  /** Keyboard handling while a mention popover is open; true when the key
   * was consumed by the popover. */
  handleKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean;
} {
  const { textareaRef, workspaceId, peerId = "", value, onChange, clearCaret } =
    options;
  const [mention, setMention] = useState<MentionState | null>(null);
  // Bumped per fetch so a stale response can never overwrite a newer one.
  const fetchSeq = useRef(0);
  const enabled = workspaceId !== undefined;

  const closeMention = useCallback(() => {
    setMention(null);
    clearCaret();
  }, [setMention, clearCaret]);

  // Debounced fetch of suggestions whenever the mention query changes.
  useEffect(() => {
    if (!mention || !mention.loading || workspaceId === undefined) return;
    const seq = ++fetchSeq.current;
    const timer = setTimeout(async () => {
      try {
        const result = peerId === ""
          ? await api.workspaceFiles(workspaceId, mention.query)
          : await fed.workspaceFiles(peerId, workspaceId, mention.query);
        if (fetchSeq.current !== seq || !mention) return;
        setMention((prev) =>
          prev ? { ...prev, items: result.entries, loading: false } : prev
        );
      } catch {
        if (fetchSeq.current !== seq || !mention) return;
        setMention((prev) =>
          prev ? { ...prev, items: [], loading: false } : prev
        );
      }
    }, 150);
    return () => clearTimeout(timer);
  }, [mention, workspaceId, peerId]);

  // Switching sessions (different workspace) must not leak a stale mention.
  useEffect(() => {
    closeMention();
  }, [workspaceId, peerId, closeMention]);

  const updateMention = useCallback(
    (nextValue: string, caret: number): boolean => {
      const det = enabled ? detectMention(nextValue, caret) : null;
      if (!det) {
        // No-op when already closed (React bails out on the same value).
        setMention((prev) => (prev === null ? prev : null));
        return false;
      }
      setMention((prev) =>
        prev && prev.start === det.start
          ? { ...prev, query: det.query, loading: true }
          : {
            start: det.start,
            query: det.query,
            items: [],
            active: 0,
            loading: true,
          }
      );
      return true;
    },
    [enabled],
  );

  /** Replace `@query` with the picked path (plus a trailing space). */
  const selectMention = useCallback(
    (index: number) => {
      const current = mention;
      const ta = textareaRef.current;
      if (!current || !ta) return;
      const item = current.items[index];
      if (!item) return;
      const caret = ta.selectionStart;
      const inserted = item.path;
      const next = value.slice(0, current.start) + inserted + " " +
        value.slice(caret);
      onChange(next);
      setMention(null);
      clearCaret();
      fetchSeq.current++;
      const caretAfter = current.start + inserted.length + 1;
      requestAnimationFrame(() => {
        ta.focus();
        ta.setSelectionRange(caretAfter, caretAfter);
      });
    },
    [mention, textareaRef, value, onChange, setMention, clearCaret],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (mention && mention.items.length > 0) {
        const count = mention.items.length;
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setMention({
            ...mention,
            active: (mention.active + 1) % count,
          });
          return true;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setMention({
            ...mention,
            active: (mention.active - 1 + count) % count,
          });
          return true;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          selectMention(mention.active);
          return true;
        }
      }
      if (mention && e.key === "Escape") {
        e.preventDefault();
        closeMention();
        return true;
      }
      return false;
    },
    [mention, setMention, selectMention, closeMention],
  );

  return {
    mention,
    setMention,
    updateMention,
    selectMention,
    closeMention,
    handleKeyDown,
  };
}
