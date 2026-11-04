import {
  IconArrowsMaximize,
  IconArrowsMinimize,
  IconX,
} from "@tabler/icons-preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/compat";
import { errorMessage } from "@lumisca/core/shared";
import { token } from "../api-client.ts";
import { useT } from "../i18n.ts";
import { EASE_OUT, EXIT_SECONDS, play } from "../motion.ts";
import { useNarrowViewport, useReducedMotion } from "../hooks/useMediaQuery.ts";
import type { StellaHandover } from "../types.ts";

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
 */

/** The slice of noVNC's RFB this pane uses. Declared locally because the
 * package ships no types. */
interface RfbClient {
  viewOnly: boolean;
  scaleViewport: boolean;
  resizeSession: boolean;
  background: string;
  disconnect(): void;
  addEventListener(type: string, listener: (event: Event) => void): void;
}

type RfbConstructor = new (
  target: Element,
  url: string,
  options?: { credentials?: { password?: string }; wsProtocols?: string[] },
) => RfbClient;

/** How long the pane takes to arrive. Long enough to read as a column being
 * laid down beside the conversation, short enough not to delay the picture
 * the user asked for. Leaving is faster (see motion.ts): the decision is made,
 * so the reply should not dawdle. */
const ENTER_SECONDS = 0.2;

interface StellaPaneProps {
  running: boolean;
  vncPort: number | null;
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

type ConnectionState = "idle" | "connecting" | "connected" | "disconnected";

/**
 * Wait until the pane has a size before creating the RFB client: noVNC
 * derives its scale from the container, and a zero-size one never recovers.
 */
function waitForSize(element: HTMLElement, timeoutMs: number): Promise<void> {
  if (element.clientWidth > 0 && element.clientHeight > 0) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const observer = new ResizeObserver(() => {
      if (element.clientWidth > 0 && element.clientHeight > 0) {
        observer.disconnect();
        clearTimeout(timer);
        resolve();
      }
    });
    observer.observe(element);
    const timer = setTimeout(() => {
      observer.disconnect();
      reject(new Error("The pane never got a size"));
    }, timeoutMs);
  });
}

export function StellaPane({
  running,
  vncPort,
  handover,
  onFinishHandover,
  onClose,
  exiting = false,
  onExitDone,
}: StellaPaneProps) {
  const t = useT();
  const hostRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLElement>(null);
  const reduceMotion = useReducedMotion();
  // On a phone the pane is the whole screen (stella.css), so it arrives from
  // the bottom edge like a sheet; a desktop column slides in from the right.
  const narrow = useNarrowViewport();

  // Arrive. Only opacity and transform move: the pane's BOX never changes
  // size, because the noVNC client re-derives its scale from that box on every
  // resize and animating the width would re-scale the picture on every frame.
  // The conversation's own width therefore snaps when the column appears —
  // reflowing a transcript for 200ms would be worse than the snap, and the
  // incoming sheet is where the eye is.
  useLayoutEffect(() => {
    const element = paneRef.current;
    if (element === null || reduceMotion) return;
    const start = narrow ? "translateY(100%)" : "translateX(16px)";
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
          ? ["translateY(100%)", "translateY(0%)"]
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
          ? ["translateY(0%)", "translateY(100%)"]
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
  const clientRef = useRef<RfbClient | null>(null);
  const [state, setState] = useState<ConnectionState>("idle");
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
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [finishing, setFinishing] = useState(false);
  const [finishError, setFinishError] = useState<string | null>(null);
  const interactive = handover !== null;

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    if (!running || vncPort === null) {
      setState("idle");
      return;
    }
    let disposed = false;
    let client: RfbClient | undefined;
    setState("connecting");
    setError(null);

    const connect = async () => {
      try {
        await waitForSize(host, 10_000);
        if (disposed) return;
        const { default: RFB } = await import("@novnc/novnc") as {
          default: RfbConstructor;
        };
        if (disposed) return;
        // The relay is same-origin: the server owns the VNC port and forwards
        // it. The token rides as a query parameter because a browser cannot
        // set headers on a WebSocket handshake.
        const protocol = location.protocol === "https:" ? "wss:" : "ws:";
        const query = token === undefined
          ? ""
          : `?token=${encodeURIComponent(token)}`;
        const url = `${protocol}//${location.host}/api/stella/screen${query}`;
        const rfb = new RFB(host, url);
        client = rfb;
        clientRef.current = rfb;
        // The view-only flag follows the hand-over (see the effect below);
        // it starts closed because the agent owns the pointer by default.
        rfb.viewOnly = true;
        rfb.scaleViewport = true;
        rfb.resizeSession = false;
        rfb.background = "transparent";
        rfb.addEventListener("connect", () => {
          if (!disposed) setState("connected");
        });
        rfb.addEventListener("disconnect", (event) => {
          if (disposed) return;
          const detail = (event as unknown as { detail?: { clean?: boolean } })
            .detail;
          setState("disconnected");
          // A clean close is the user or the machine stopping; an unclean one
          // means the relay dropped, which the user must be told about (the
          // pane would otherwise sit on a frozen picture).
          if (detail?.clean !== true) {
            setError(
              t("chat.stella.machine.screenFailed", {
                reason: "the connection was closed",
              }),
            );
          }
        });
        rfb.addEventListener("securityfailure", () => {
          if (disposed) return;
          setState("disconnected");
          setError(
            t("chat.stella.machine.screenFailed", {
              reason: "the machine refused the connection",
            }),
          );
        });
      } catch (failure) {
        if (disposed) return;
        setState("disconnected");
        setError(
          t("chat.stella.machine.screenFailed", {
            reason: failure instanceof Error
              ? failure.message
              : String(failure),
          }),
        );
      }
    };
    void connect();

    return () => {
      disposed = true;
      clientRef.current = null;
      try {
        client?.disconnect();
      } catch {
        // Already gone (the machine stopped); nothing to do.
      }
    };
  }, [running, vncPort, t]);

  // The view-only flag follows the hand-over: the agent owns the pointer
  // while it works, the user owns it while the run waits for them. Applied
  // to the live client (no reconnect: the picture and the handshake stay).
  useEffect(() => {
    const rfb = clientRef.current;
    if (rfb === null) return;
    rfb.viewOnly = !interactive;
  }, [interactive, state]);

  return (
    <aside
      ref={paneRef}
      className={`stella-pane${interactive ? " handover" : ""}${
        fullscreen ? " fullscreen" : ""
      }${exiting ? " exiting" : ""}`}
    >
      <header className="stella-pane-header">
        <span>{t("chat.stella.machine.screen")}</span>
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
          {fullscreen
            ? <IconArrowsMinimize size={15} />
            : <IconArrowsMaximize size={15} />}
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
        <form
          className="stella-handover"
          onSubmit={(event) => {
            event.preventDefault();
            if (finishing) return;
            setFinishing(true);
            setFinishError(null);
            onFinishHandover(note.trim(), handover.toolCallId)
              .then(() => setNote(""))
              .catch((failure) => {
                setFinishError(
                  errorMessage(failure),
                );
              })
              .finally(() => setFinishing(false));
          }}
        >
          <p className="stella-handover-label">
            {t("chat.stella.handover.reason")}
          </p>
          <p className="stella-handover-reason">{handover.reason}</p>
          {handover.instructions !== null && (
            <p className="stella-handover-instructions">
              {handover.instructions}
            </p>
          )}
          <div className="stella-handover-actions">
            <input
              type="text"
              className="stella-handover-note"
              placeholder={t("chat.stella.handover.notePlaceholder")}
              aria-label={t("chat.stella.handover.notePlaceholder")}
              value={note}
              onChange={(event) => setNote(event.currentTarget.value)}
            />
            <button
              type="submit"
              className="btn primary"
              disabled={finishing}
            >
              {finishing
                ? t("chat.stella.handover.finishing")
                : t("chat.stella.handover.done")}
            </button>
          </div>
          {finishError !== null && (
            <p className="error-text" role="alert">{finishError}</p>
          )}
        </form>
      )}
      <div className="stella-pane-body">
        {!running && (
          <p className="stella-pane-note">
            {t("chat.stella.machine.screenEmpty")}
          </p>
        )}
        {running && state === "connecting" && (
          <p className="stella-pane-note">
            {t("chat.stella.machine.screenConnecting")}
          </p>
        )}
        {error !== null && (
          <p className="error-text stella-pane-note" role="alert">{error}</p>
        )}
        {
          /* noVNC renders into this element; it must not be replaced while the
            connection lives (the client holds the node). */
        }
        <div ref={hostRef} className="stella-pane-screen" />
      </div>
    </aside>
  );
}
