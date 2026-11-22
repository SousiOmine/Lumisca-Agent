/**
 * The noVNC surface this pane needs, and the one keystroke it sends.
 *
 * The package ships no types, so the slice the pane uses is declared here
 * rather than at each use: the screen component creates and drives a client,
 * and the clipboard exchange presses a chord in it, so both sides have to
 * name the same shape.
 *
 * The clipboard crosses through the server (core/vm/clipboard.ts) rather than
 * the VNC connection, because x11vnc's cut text is ISO 8859-1: the client is
 * only the signal (a cut-text announcement) and the finger that presses the
 * paste chord (see stella-clipboard.ts).
 */

/** The slice of noVNC's RFB this pane uses. Declared locally because the
 * package ships no types. */
export interface RfbClient {
  viewOnly: boolean;
  scaleViewport: boolean;
  resizeSession: boolean;
  background: string;
  disconnect(): void;
  addEventListener(type: string, listener: (event: Event) => void): void;
  /** One key event, by X11 keysym and DOM code. A no-op when the client is
   * not connected, or while it is view-only. */
  sendKey(keysym: number, code: string, down?: boolean): void;
}

/** The constructor `@novnc/novnc` exports as its default. */
export type RfbConstructor = new (
  target: Element,
  url: string,
  options?: { credentials?: { password?: string }; wsProtocols?: string[] },
) => RfbClient;

/**
 * Wait until the pane has a size before creating the RFB client: noVNC
 * derives its scale from the container, and a zero-size one never recovers.
 */
export function waitForSize(
  element: HTMLElement,
  timeoutMs: number,
): Promise<void> {
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

/** The keys of the paste chord, as X11 keysyms and DOM codes (noVNC's
 * `KeyTable` is not exported, and these names are the protocol's, not a
 * choice of ours). */
const XK_CONTROL_L = 0xffe3;
const XK_SHIFT_L = 0xffe1;
const XK_V = 0x76;

/** Press the paste chord on the machine, so the application reads the
 * selection the server just filled. Sent after the write answered: a key
 * before it would paste the machine's older clipboard. The modifiers are
 * released in `finally` so a thrown send cannot leave Ctrl held down. */
export function pressPaste(
  rfb: RfbClient | null,
  chord: { shift: boolean },
): void {
  if (rfb === null) return;
  rfb.sendKey(XK_CONTROL_L, "ControlLeft", true);
  try {
    if (chord.shift) rfb.sendKey(XK_SHIFT_L, "ShiftLeft", true);
    rfb.sendKey(XK_V, "KeyV", true);
    rfb.sendKey(XK_V, "KeyV", false);
  } finally {
    if (chord.shift) rfb.sendKey(XK_SHIFT_L, "ShiftLeft", false);
    rfb.sendKey(XK_CONTROL_L, "ControlLeft", false);
  }
}
