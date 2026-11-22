import {
  errorMessage,
  type MessageKey,
  type MessageParams,
} from "@lumisca/core/shared";
import type { RefObject } from "preact/compat";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { stellaApi } from "../api-stella.ts";
import {
  normalizeClipboardText,
  type PasteChord,
  pasteChordOf,
} from "../stella-clipboard.ts";
import { pressPaste, type RfbClient } from "../stella-rfb.ts";

/**
 * The clipboard the user and the machine share.
 *
 * While the user drives the screen they need both directions: a password
 * copied on this PC has to reach the machine's field, and an error message
 * copied in the machine has to reach this PC. The text never travels over the
 * VNC connection — its cut text is ISO 8859-1, so Japanese would arrive as
 * question marks — and goes through the server instead (see
 * core/vm/clipboard.ts). noVNC is only the signal (a cut-text announcement
 * says the machine's selection changed) and the finger that presses the paste
 * chord in the machine.
 *
 * The two directions are two words in the hand-over bar, and Ctrl+V over the
 * screen is the same paste. Nothing else is drawn: what worked is visible on
 * its own (the text appears where it was pasted, or on this PC's clipboard),
 * so only a failure needs a sentence.
 */

/** How long a cut-text announcement from the machine waits before its text is
 * read. A selection inside the machine moves PRIMARY and CLIPBOARD more than
 * once, and each move is one announcement; the text only matters after the
 * last of them. */
const CLIPBOARD_SIGNAL_MS = 300;

/** Whether an element takes typed text itself (the hand-over note, the manual
 * paste field). A paste into one of those must stay a browser paste. */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/** A sentence about the last exchange, when it needs one. */
export interface ClipboardNote {
  tone: "ok" | "error";
  key: MessageKey;
  params?: MessageParams;
}

export interface MachineClipboard {
  /** Both sides can be reached: the run waits on the user, and there is a
   * conversation to cross the text through. */
  available: boolean;
  /** A write is in flight; the two words are disabled meanwhile. */
  busy: boolean;
  /** What the last exchange needs to say, or null. */
  note: ClipboardNote | null;
  /** Put this PC's clipboard into the machine and press the paste chord
   * there. Stable for the life of the conversation, so a listener may depend
   * on it. */
  paste: (chord: PasteChord) => Promise<void>;
  /** Take the machine's clipboard onto this PC's. `announce` says whether the
   * user asked — an announcement racing the end of a hand-over is not worth a
   * sentence. Stable for the life of the conversation. */
  copy: (announce: boolean) => Promise<void>;
  /** A cut-text announcement arrived from the machine. */
  signal: () => void;
}

export function useMachineClipboard({
  paneRef,
  clientRef,
  agentId,
  interactive,
}: {
  /** The pane itself: Ctrl+V over the screen is the paste. */
  paneRef: RefObject<HTMLElement | null>;
  /** The live RFB client, which presses the chord in the machine. */
  clientRef: RefObject<RfbClient | null>;
  /** The conversation whose API crosses the text. Null while no conversation
   * exists, so there is nothing to exchange it with. */
  agentId: string | null;
  /** The run waits on the user (a hand-over is up). */
  interactive: boolean;
}): MachineClipboard {
  const available = interactive && agentId !== null;
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<ClipboardNote | null>(null);
  /** The text last handed to either side. A write of ours comes back as an
   * announcement from the machine, and reading it in again would overwrite
   * whatever this PC's clipboard holds now; this is what stops that. */
  const lastSynced = useRef<string | null>(null);
  /** Guards the write path against a second press while the first write is
   * still crossing: two writes would race for the same selection. */
  const writing = useRef(false);
  /** The debounce of a cut-text announcement. */
  const signalTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  useEffect(() => () => clearTimeout(signalTimer.current), []);

  /** Put this PC's clipboard into the machine and press the paste chord there.
   * The button and Ctrl+V over the screen are the same action. */
  const paste = useCallback(
    async (chord: PasteChord) => {
      if (agentId === null || writing.current) return;
      let text: string;
      try {
        text = await navigator.clipboard.readText();
      } catch {
        // A denied permission, or a page on plain http where the API does not
        // exist at all: nothing can be read, so the button says why.
        setNote({
          tone: "error",
          key: "chat.stella.handover.clipboard.pasteReadFailed",
        });
        return;
      }
      const normalized = normalizeClipboardText(text);
      if (normalized.length === 0) {
        setNote({
          tone: "error",
          key: "chat.stella.handover.clipboard.pasteEmpty",
        });
        return;
      }
      writing.current = true;
      setBusy(true);
      setNote(null);
      try {
        await stellaApi.writeClipboard(agentId, normalized);
        lastSynced.current = normalized;
        pressPaste(clientRef.current, chord);
      } catch (failure) {
        setNote({
          tone: "error",
          key: "chat.stella.handover.clipboard.pasteFailed",
          params: { reason: errorMessage(failure) },
        });
      } finally {
        writing.current = false;
        setBusy(false);
      }
    },
    [agentId, clientRef],
  );

  /** Take the machine's clipboard onto this PC's: the button, and the
   * machine's own announcement. */
  const copy = useCallback(
    async (announce: boolean) => {
      if (agentId === null) return;
      setBusy(true);
      if (announce) setNote(null);
      try {
        const { text } = await stellaApi.readClipboard(agentId);
        if (text.length === 0) {
          if (announce) {
            setNote({
              tone: "ok",
              key: "chat.stella.handover.clipboard.copyNothing",
            });
          }
          return;
        }
        // Our own write, announced back by the machine: this PC's clipboard
        // is not touched.
        if (text === lastSynced.current) return;
        lastSynced.current = text;
        try {
          await navigator.clipboard.writeText(text);
          if (announce) {
            setNote({
              tone: "ok",
              key: "chat.stella.handover.clipboard.copied",
            });
          }
        } catch {
          // Refused (no user gesture, or a page without the API). The user has
          // to know: what they paste next would be the older text.
          setNote({
            tone: "error",
            key: "chat.stella.handover.clipboard.copyFailed",
          });
        }
      } catch (failure) {
        if (!announce) return;
        setNote({
          tone: "error",
          key: "chat.stella.handover.clipboard.copyError",
          params: { reason: errorMessage(failure) },
        });
      } finally {
        setBusy(false);
      }
    },
    [agentId],
  );

  /** A cut-text announcement from the machine, debounced: one selection moves
   * the selection more than once. The event's own text is the Latin-1
   * stand-in, so only its arrival is used; the real text is read back through
   * the server. */
  const signal = useCallback(() => {
    if (!available) return;
    clearTimeout(signalTimer.current);
    signalTimer.current = setTimeout(() => {
      void copy(false);
    }, CLIPBOARD_SIGNAL_MS);
  }, [available, copy]);

  // A hand-over ending forgets what was exchanged: the next one starts from
  // the machine's clipboard as it is then, not from a value this pane handed
  // across last time (same text, hours apart, would otherwise be deduped).
  useEffect(() => {
    if (interactive) return;
    lastSynced.current = null;
    setNote(null);
  }, [interactive]);

  // A paste pressed over the screen belongs to the machine, but the machine's
  // clipboard is not what the user copied there: the text has to cross first.
  // The listener is in the capture phase on the pane itself, so the event
  // stops before noVNC's canvas sends a bare Ctrl+V (which would paste the
  // machine's older clipboard); a field inside the pane keeps its own paste.
  useEffect(() => {
    if (!available) return;
    const element = paneRef.current;
    if (element === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return;
      const chord = pasteChordOf(event);
      if (chord === null) return;
      event.preventDefault();
      event.stopPropagation();
      void paste(chord);
    };
    element.addEventListener("keydown", onKeyDown, true);
    return () => element.removeEventListener("keydown", onKeyDown, true);
  }, [available, paste, paneRef]);

  return {
    available,
    busy,
    note,
    paste,
    copy,
    signal,
  };
}
