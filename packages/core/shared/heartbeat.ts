/**
 * Liveness of the event stream (`/ws`).
 *
 * An idle event stream looks exactly like a dead one: nothing arrives either
 * way, and a socket that died silently (a NAT/proxy timeout, a suspended
 * mobile page, a link change) fires no `close` until the OS notices — which
 * can be hours. The server therefore sends a heartbeat frame on a fixed
 * cadence, and the client treats silence past a deadline as a dead socket,
 * closes it and reconnects (which re-reads the snapshot).
 *
 * The frame is transport-level, not a `ClientEvent`: `connectEvents` swallows
 * it and only refreshes its watchdog, so no reducer ever sees it. WebSocket
 * ping frames are not available on either side of this stack (the browser API
 * and Deno's WebSocket expose data frames only), hence a plain JSON frame.
 *
 * The client's deadline spans three server intervals: one lost frame (a
 * hiccup, a throttled background tab) must not tear a live connection down.
 */
export const WS_HEARTBEAT_TYPE = "heartbeat";

/** How often the server sends a heartbeat while the connection is idle.
 * Short enough to keep NAT/proxy idle timeouts away and to notice a silent
 * drop promptly; long enough to be free. */
export const WS_HEARTBEAT_INTERVAL_MS = 15_000;

/** How long the client waits for any frame before treating the socket as
 * dead (three heartbeat intervals). */
export const WS_HEARTBEAT_TIMEOUT_MS = 45_000;

/** How often the client checks the deadline. A hidden page's timers are
 * throttled or suspended, so the check is only trusted while the page is
 * visible (see the web's heartbeat watchdog); a tab returning to the
 * foreground checks immediately. */
export const WS_HEARTBEAT_CHECK_MS = 5_000;
