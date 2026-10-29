import { IconX } from "@tabler/icons-preact";
import { useEffect, useRef, useState } from "preact/compat";
import { token } from "../api-client.ts";
import { useT } from "../i18n.ts";

/**
 * The machine's screen, live.
 *
 * The picture comes from the container's x11vnc through the server's
 * WebSocket relay (server/stella-screen.ts), so the VNC port itself is never
 * reachable from the browser — only the relay, behind the same token and Host
 * checks as every other route.
 *
 * The pane is view-only. The agent is the one that clicks: a user and an agent
 * moving the same pointer produces actions neither of them intended, and
 * stella's whole design is "the agent works in its machine while the user
 * watches". Taking over is a feature this mode does not have.
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
  onClose: () => void;
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

export function StellaPane({ running, vncPort, onClose }: StellaPaneProps) {
  const t = useT();
  const hostRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<ConnectionState>("idle");
  const [error, setError] = useState<string | null>(null);

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
      try {
        client?.disconnect();
      } catch {
        // Already gone (the machine stopped); nothing to do.
      }
    };
  }, [running, vncPort, t]);

  return (
    <aside className="stella-pane">
      <header className="stella-pane-header">
        <span>{t("chat.stella.machine.screen")}</span>
        <button
          type="button"
          className="icon-btn"
          onClick={onClose}
          title={t("common.close")}
          aria-label={t("common.close")}
        >
          <IconX size={15} />
        </button>
      </header>
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
