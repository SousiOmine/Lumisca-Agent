import type { RefObject } from "preact/compat";
import { useEffect, useRef, useState } from "preact/hooks";
import { wsUrl } from "../../api-client.ts";
import { useT } from "../../i18n.ts";
import {
  type RfbClient,
  type RfbConstructor,
  waitForSize,
} from "../../stella-rfb.ts";
import type { StellaMachineStatus } from "../../types.ts";

/**
 * The machine's screen itself: the heading, the notes about it, and the
 * element noVNC draws into.
 *
 * The connection lives here because it belongs to that element: the client
 * holds the node, re-derives its scale from the box on every resize, and is
 * disconnected when the machine stops. Split out of StellaPane.tsx so the
 * pane keeps what the screen means to the rest of the app (the hand-over, the
 * clipboard exchange, the lent folders) instead of also owning a protocol
 * client.
 */

type ConnectionState = "idle" | "connecting" | "connected" | "disconnected";

export function StellaMachineScreen({
  machine,
  waking,
  wakeError,
  onWake,
  agentId,
  interactive,
  onActivity,
  clientRef,
  onClipboardSignal,
}: {
  /** The conversation's machine: running, asleep (`stopped`) or being
   * started. */
  machine: StellaMachineStatus | null;
  /** A wake was asked for and has not finished. */
  waking: boolean;
  /** Why the wake failed, when it did. */
  wakeError: string | null;
  onWake: () => void;
  /** The agent whose conversation this is: the relay resolves the agent to
   * its own machine, and without one it has no desktop to show. */
  agentId: string | null;
  /** The user drives the screen (a hand-over is waiting on them); the agent
   * owns the pointer otherwise. */
  interactive: boolean;
  /** The user did something on the screen: keep the machine awake. */
  onActivity: () => void;
  /** Filled with the live client while the connection lasts, so the pane can
   * press the paste chord in the machine. */
  clientRef: RefObject<RfbClient | null>;
  /** The machine's selection changed (a cut-text announcement). The event's
   * own text is a Latin-1 stand-in and is not read. */
  onClipboardSignal: () => void;
}) {
  const t = useT();
  // A running machine is the only one with a screen to show. `stopped` is the
  // idle sleep: the picture is gone, and the pane says so instead of leaving a
  // frozen one.
  const running = machine?.state === "running";
  const asleep = machine?.state === "stopped";
  const hostRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<ConnectionState>("idle");
  const [error, setError] = useState<string | null>(null);

  // The RFB listener is installed once, in the connect effect, so the
  // announcement handler is read from a ref rather than captured there. The
  // ref is written in an effect (not during render) and before that effect,
  // so the listener always calls the handler of the latest render.
  const signalRef = useRef(onClipboardSignal);
  useEffect(() => {
    signalRef.current = onClipboardSignal;
  }, [onClipboardSignal]);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    if (!running) {
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
        const { default: RFB } = (await import("@novnc/novnc")) as {
          default: RfbConstructor;
        };
        if (disposed) return;
        // The relay is on the API origin: the server owns the VNC port and
        // forwards it. `wsUrl` names the origin and carries the token, which a
        // browser cannot put in a handshake header.
        const query = new URLSearchParams();
        // The pane is one conversation's desktop. Without the agent the
        // relay has no desktop to show.
        if (agentId !== null) query.set("agent", agentId);
        const search = query.toString();
        const url = wsUrl(
          `/api/stella/screen${search === "" ? "" : `?${search}`}`,
        );
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
        // The machine's selection changed. The event's `detail.text` is not
        // the text: the VNC cut text is ISO 8859-1, so it is a stand-in for
        // whatever was copied (Japanese arrives as question marks). Only its
        // arrival is used; the machine is asked for the real text.
        rfb.addEventListener("clipboard", () => signalRef.current());
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
            reason:
              failure instanceof Error ? failure.message : String(failure),
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
  }, [running, agentId, t, clientRef]);

  // Driving the screen is use: a press, a key, a wheel notch or a touch
  // reports the agent's machine as used, which keeps its idle clock fresh
  // (see useAgentMachine). Pointer MOVES are not reported — noVNC also sends
  // framebuffer requests continuously, so counting traffic would keep a pane
  // nobody is looking at awake forever.
  useEffect(() => {
    const host = hostRef.current;
    if (host === null || !running) return;
    const report = () => onActivity();
    const events = ["pointerdown", "keydown", "wheel", "touchstart"];
    for (const name of events) host.addEventListener(name, report, true);
    return () => {
      for (const name of events) host.removeEventListener(name, report, true);
    };
  }, [running, onActivity]);

  // A machine that went to sleep closes the relay, which looks like a failed
  // connection. The pane says "asleep" instead, so the failure text must not
  // outlive the running state.
  useEffect(() => {
    if (!running) setError(null);
  }, [running]);

  // The view-only flag follows the hand-over: the agent owns the pointer
  // while it works, the user owns it while the run waits for them. Applied
  // to the live client (no reconnect: the picture and the handshake stay).
  useEffect(() => {
    const rfb = clientRef.current;
    if (rfb === null) return;
    rfb.viewOnly = !interactive;
  }, [interactive, state, clientRef]);

  return (
    <>
      <h3 className="stella-pane-section stella-pane-screen-title">
        {t("chat.stella.machine.screen")}
      </h3>
      <div className="stella-pane-body">
        {!running && asleep && (
          <div className="stella-pane-asleep">
            <p className="stella-pane-note">
              {t("chat.stella.machine.asleep")}
            </p>
            <button
              type="button"
              className="btn"
              onClick={onWake}
              disabled={waking}
            >
              {waking
                ? t("chat.stella.machine.waking")
                : t("chat.stella.machine.wake")}
            </button>
            {wakeError !== null && (
              <p className="error-text" role="alert">
                {wakeError}
              </p>
            )}
          </div>
        )}
        {running && state === "connecting" && (
          <p className="stella-pane-note">
            {t("chat.stella.machine.screenConnecting")}
          </p>
        )}
        {error !== null && (
          <p className="error-text stella-pane-note" role="alert">
            {error}
          </p>
        )}
        {/* noVNC renders into this element; it must not be replaced while the
            connection lives (the client holds the node). */}
        <div ref={hostRef} className="stella-pane-screen" />
      </div>
    </>
  );
}
