import { errorMessage } from "@lumisca/core/shared";
import {
  IconArrowsMaximize,
  IconArrowsMinimize,
  IconX,
} from "@tabler/icons-preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { useMachineClipboard } from "../hooks/useMachineClipboard.ts";
import { useNarrowViewport, useReducedMotion } from "../hooks/useMediaQuery.ts";
import { useT } from "../i18n.ts";
import { EASE_OUT, EXIT_SECONDS, play } from "../motion.ts";
import type { RfbClient } from "../stella-rfb.ts";
import type {
  FolderShare,
  StellaHandover,
  StellaMachineStatus,
} from "../types.ts";
import { ShareList } from "./stella/ShareList.tsx";
import { StellaHandoverForm } from "./stella/StellaHandoverForm.tsx";
import { StellaMachineScreen } from "./stella/StellaMachineScreen.tsx";

/**
 * The machine's screen, live.
 *
 * The picture comes from the container's x11vnc through the server's
 * WebSocket relay (server/stella-screen.ts), so the VNC port itself is never
 * reachable from the browser — only the relay, behind the same token and Host
 * checks as every other route.
 *
 * The pane is view-only except during a hand-over: when the agent calls
 * `vm_ask_user` the run stops and the screen becomes the user's (a password,
 * a CAPTCHA, a consent dialog). Two pointers on one screen is a bug, so the
 * two states are exclusive — while the agent works the pane is a window,
 * while it waits the pane is an input device.
 *
 * What the pane itself owns is that state and its lifetime: the entrance and
 * the exit, full screen, whether the pointer is the user's, and the clipboard
 * that crosses while it is. The picture and its connection are
 * stella/StellaMachineScreen.tsx, the bar the run waits on is
 * stella/StellaHandoverForm.tsx, and the clipboard exchange is
 * hooks/useMachineClipboard.
 */

/** How long the pane takes to arrive. Long enough to read as a column being
 * laid down beside the conversation, short enough not to delay the picture
 * the user asked for. Leaving is faster (see motion.ts): the decision is made,
 * so the reply should not dawdle. */
const ENTER_SECONDS = 0.2;

interface StellaPaneProps {
  /** The conversation's machine: running, asleep (`stopped`) or being
   * started. Which screen the picture comes from is the server's business:
   * the relay resolves the conversation's agent to its own machine. */
  machine: StellaMachineStatus | null;
  /** A wake was asked for and has not finished. */
  waking: boolean;
  /** Why the wake failed, when it did. */
  wakeError: string | null;
  /** Wake the machine (the "wake" button under the asleep note). */
  onWake: () => void;
  /** The user did something on the screen: keep the machine awake. */
  onActivity: () => void;
  /** The folders lent from this computer to this conversation. They are drawn
   * above the screen: what the agent can reach is a fact about the run, and
   * the way to take it back has to be where the loan is named. */
  shares: readonly FolderShare[];
  /** The agent whose conversation this is: the clipboard crosses through that
   * conversation's API. Null while no conversation exists (the pane then has
   * nothing to exchange text with). */
  agentId: string | null;
  /** The pane is on its way out (see StellaView and hooks/usePresence). It
   * plays its exit and then calls `onExitDone`. */
  exiting?: boolean;
  /** The exit is over: the caller may unmount the pane. */
  onExitDone?: () => void;
  /** The hand-over the run is waiting on, or null. While set, the pane is
   * interactive and the "done" bar is shown. */
  handover: StellaHandover | null;
  /** The user finished at the screen: send what they did (may be empty). */
  onFinishHandover: (note: string, toolCallId: string) => Promise<void>;
  /** Close the pane. Omitted while the agent waits for the user: the run is
   * blocked on this pane, so there is nothing to close it into. */
  onClose?: () => void;
}

export function StellaPane({
  machine,
  waking,
  wakeError,
  onWake,
  onActivity,
  shares,
  agentId,
  handover,
  onFinishHandover,
  onClose,
  exiting = false,
  onExitDone,
}: StellaPaneProps) {
  const t = useT();
  const paneRef = useRef<HTMLElement>(null);
  const reduceMotion = useReducedMotion();
  // The pane arrives from the right at every width: its toggle draws a right
  // sidebar, so a sheet rising from the bottom edge read as a different
  // surface. A phone's pane is the whole screen (stella.css) and travels its
  // own width; a desktop column only needs the hint of a direction.
  const narrow = useNarrowViewport();
  const clientRef = useRef<RfbClient | null>(null);
  const interactive = handover !== null;
  // The hand-over bar's own state lives here rather than in the form: the bar
  // comes and goes with each hand-over while the pane stays mounted, so a note
  // left unsent outlives the form that wrote it, as it did when both were one
  // component.
  const [note, setNote] = useState("");
  const [finishing, setFinishing] = useState(false);
  const [finishError, setFinishError] = useState<string | null>(null);

  /** Send what the user did at the screen. A send already in flight is not
   * repeated: the two would answer the same hand-over. */
  const finishHandover = () => {
    if (handover === null || finishing) return;
    setFinishing(true);
    setFinishError(null);
    onFinishHandover(note.trim(), handover.toolCallId)
      .then(() => setNote(""))
      .catch((failure) => {
        setFinishError(errorMessage(failure));
      })
      .finally(() => setFinishing(false));
  };

  // Arrive. Only opacity and transform move: the pane's BOX never changes
  // size, because the noVNC client re-derives its scale from that box on every
  // resize and animating the width would re-scale the picture on every frame.
  // The conversation's own width therefore snaps when the column appears —
  // reflowing a transcript for 200ms would be worse than the snap, and the
  // incoming sheet is where the eye is.
  useLayoutEffect(() => {
    const element = paneRef.current;
    if (element === null || reduceMotion) return;
    const start = narrow ? "translateX(100%)" : "translateX(16px)";
    // Hide it before the first paint: `play` reaches the library through an
    // import, so the animation cannot start in this tick, and without this the
    // pane would paint at its final place and then jump back to the start.
    element.style.opacity = "0";
    element.style.transform = start;
    let cancelled = false;
    void play(
      element,
      {
        opacity: [0, 1],
        transform: narrow
          ? ["translateX(100%)", "translateX(0%)"]
          : ["translateX(16px)", "translateX(0px)"],
      },
      {
        duration: ENTER_SECONDS,
        easing: EASE_OUT,
        prefersReducedMotion: reduceMotion,
      },
    ).then((playing) => {
      // Nothing to play (the library could not be loaded): show the pane as
      // it is instead of leaving it invisible.
      if (cancelled || playing !== null) return;
      element.style.opacity = "";
      element.style.transform = "";
    });
    return () => {
      cancelled = true;
    };
    // Once, on mount: a resize of the window must not replay the entrance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Leave. The element stays mounted until the exit is over (the caller keeps
  // it up through usePresence), so the pane does not vanish from under the
  // pointer it was following.
  useEffect(() => {
    if (!exiting) return;
    const element = paneRef.current;
    const finish = onExitDone ?? (() => {});
    if (element === null || reduceMotion) {
      finish();
      return;
    }
    let cancelled = false;
    void play(
      element,
      {
        opacity: [1, 0],
        transform: narrow
          ? ["translateX(0%)", "translateX(100%)"]
          : ["translateX(0px)", "translateX(16px)"],
      },
      {
        duration: EXIT_SECONDS,
        easing: EASE_OUT,
        prefersReducedMotion: reduceMotion,
      },
    ).then((playing) => {
      // Nothing to play (the library is still loading, or it failed): the
      // pane goes without its exit rather than waiting forever.
      if (cancelled) return;
      if (playing === null) {
        finish();
        return;
      }
      void playing.finished.then(() => {
        if (!cancelled) finish();
      });
    });
    return () => {
      cancelled = true;
    };
  }, [exiting, reduceMotion, narrow, onExitDone]);

  /** The pane covers the window instead of sitting in its column. */
  const [fullscreen, setFullscreen] = useState(false);

  /** Escape leaves full screen, the way every other expanded surface in the
   * app answers Escape. The listener lives only while the mode does: the pane
   * is not otherwise a keyboard surface, and a global handler that is always
   * on would swallow the key from the composer. */
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFullscreen(false);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [fullscreen]);

  // The clipboard the user and the machine share. It is drawn in the
  // hand-over bar (the two words) and driven with Ctrl+V over the screen.
  const clipboard = useMachineClipboard({
    paneRef,
    clientRef,
    agentId,
    interactive,
  });

  return (
    <aside
      ref={paneRef}
      className={`stella-pane${interactive ? " handover" : ""}${
        fullscreen ? " fullscreen" : ""
      }${exiting ? " exiting" : ""}`}
      aria-label={t("chat.stella.machine.info")}
    >
      <header className="stella-pane-header">
        <button
          type="button"
          className="icon-btn"
          onClick={() => setFullscreen((on) => !on)}
          title={t(
            fullscreen
              ? "chat.stella.machine.exitFullscreen"
              : "chat.stella.machine.fullscreen",
          )}
          aria-label={t(
            fullscreen
              ? "chat.stella.machine.exitFullscreen"
              : "chat.stella.machine.fullscreen",
          )}
          aria-pressed={fullscreen}
        >
          {fullscreen ? (
            <IconArrowsMinimize size={15} />
          ) : (
            <IconArrowsMaximize size={15} />
          )}
        </button>
        {onClose !== undefined && (
          <button
            type="button"
            className="icon-btn"
            onClick={onClose}
            title={t("common.close")}
            aria-label={t("common.close")}
          >
            <IconX size={15} />
          </button>
        )}
      </header>
      {handover !== null && (
        <StellaHandoverForm
          handover={handover}
          note={note}
          onNoteChange={setNote}
          finishing={finishing}
          finishError={finishError}
          onSubmit={finishHandover}
          clipboard={
            clipboard.available
              ? {
                  busy: clipboard.busy,
                  note: clipboard.note,
                  onCopy: () => void clipboard.copy(true),
                  onPaste: () => void clipboard.paste({ shift: false }),
                }
              : undefined
          }
        />
      )}
      <StellaMachineScreen
        machine={machine}
        waking={waking}
        wakeError={wakeError}
        onWake={onWake}
        agentId={agentId}
        interactive={interactive}
        onActivity={onActivity}
        clientRef={clientRef}
        onClipboardSignal={clipboard.signal}
      />
      <ShareList shares={shares} />
    </aside>
  );
}
