import { IconX } from "@tabler/icons-preact";
import { useEffect, useRef, useState } from "preact/compat";
import { errorMessage } from "@lumisca/core/shared";
import { token } from "../api-client.ts";
import { useT } from "../i18n.ts";
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

interface StellaPaneProps {
  running: boolean;
  vncPort: number | null;
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
}: StellaPaneProps) {
  const t = useT();
  const hostRef = useRef<HTMLDivElement>(null);
  const clientRef = useRef<RfbClient | null>(null);
  const [state, setState] = useState<ConnectionState>("idle");
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
    <aside className={`stella-pane${interactive ? " handover" : ""}`}>
      <header className="stella-pane-header">
        <span>{t("chat.stella.machine.screen")}</span>
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
