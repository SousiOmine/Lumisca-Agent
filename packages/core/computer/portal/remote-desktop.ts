/**
 * The RemoteDesktop + ScreenCast session: one shared set of monitors with
 * pointer and keyboard input.
 *
 * The flow is the portal's own: CreateSession, SelectDevices (which input
 * devices the agent wants), ScreenCast.SelectSources (which monitors the
 * user is willing to share) and Start (the actual consent dialog). Start
 * answers with the streams it created and, when persist_mode asked for it, a
 * restore token that later sessions pass back to skip the dialog.
 *
 * Absolute pointer motion takes coordinates in the STREAM's own pixel grid,
 * which mutter resolves with `logical = monitor + stream / monitor.scale`.
 * The scale is not part of the stream metadata; the caller (wayland.ts)
 * supplies it from the monitor layout.
 *
 * Buttons are evdev codes (mutter converts them itself), and a discrete
 * scroll step is what a wheel notch is: axis 0 is vertical with positive
 * steps scrolling down, axis 1 horizontal with positive steps scrolling
 * right.
 */
import { CoreError } from "../../errors.ts";
import type { MouseButton } from "../types.ts";
import { type PortalConnection, unwrapVariant } from "./connection.ts";
import {
  callPortalRequest,
  newRequestToken,
  REQUEST_TIMEOUT_MS,
  type RequestOutcome,
} from "./request.ts";
import { PORTAL_DESTINATION, PORTAL_PATH } from "./screenshot.ts";
import type {
  PortalSession,
  PortalStream,
  RestoreTokenStore,
} from "./types.ts";

export const REMOTE_DESKTOP_INTERFACE = "org.freedesktop.portal.RemoteDesktop";
export const SCREEN_CAST_INTERFACE = "org.freedesktop.portal.ScreenCast";
export const SESSION_INTERFACE = "org.freedesktop.portal.Session";

/** RemoteDesktop device types (portal spec). */
export const DEVICE_KEYBOARD = 1;
export const DEVICE_POINTER = 2;
/** ScreenCast source types: monitors only. Windows would be meaningless to
 * an agent that cannot see them. */
export const SOURCE_MONITOR = 1;
/** Cursor mode "embedded": a choice the portal requires even though the
 * agent never consumes the video frames. */
const CURSOR_EMBEDDED = 2;
/** persist_mode 2 = "persist forever": the portal returns a restore token
 * that carries the granted devices and streams, so a later session starts
 * without a dialog (GNOME skips it when the token restores — see the
 * `restore_from_data` check in its RemoteDesktop backend). */
const PERSISTENT = 2;

/** evdev button codes (BTN_LEFT, BTN_RIGHT, BTN_MIDDLE); mutter's
 * NotifyPointerButton converts them to its own numbering. */
const BUTTON_CODES: Record<MouseButton, number> = {
  left: 272,
  right: 273,
  middle: 274,
};

/** 1 = pressed, 0 = released (portal spec). */
const PRESSED = 1;
const RELEASED = 0;

export interface RemoteDesktopOptions {
  connection: PortalConnection;
  /** Where the restore token is kept, when the machine has one. */
  store?: RestoreTokenStore;
  /** How long the consent dialog may wait for the user. */
  timeoutMs?: number;
}

/** Share the monitors the user picks and open a session with input. */
export async function openRemoteDesktopSession(
  options: RemoteDesktopOptions,
): Promise<PortalSession> {
  const { connection } = options;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  /** One portal request. The options dictionary — carrying the handle token
   * the request object is named after — is always the LAST argument; `args`
   * are the ones before it and `signature` spells both out, because getting
   * a signature wrong costs a D-Bus InvalidArgs round trip (measured: Start
   * without its parent_window argument):
   *
   *   CreateSession            (a{sv})
   *   SelectDevices            (o, a{sv})
   *   ScreenCast.SelectSources (o, a{sv})
   *   Start                    (o, s parent_window, a{sv})
   */
  const portalRequest = (
    interfaceName: string,
    member: string,
    signature: string,
    args: unknown[],
    options: Record<string, unknown> = {},
  ): Promise<RequestOutcome> => {
    const token = newRequestToken();
    return callPortalRequest(
      connection,
      {
        destination: PORTAL_DESTINATION,
        path: PORTAL_PATH,
        interface: interfaceName,
        member,
        signature,
        body: [
          ...args,
          { handle_token: connection.variant("s", token), ...options },
        ],
      },
      token,
      timeoutMs,
    );
  };

  const created = await portalRequest(
    REMOTE_DESKTOP_INTERFACE,
    "CreateSession",
    "a{sv}",
    [],
    { session_handle_token: connection.variant("s", newRequestToken()) },
  );
  const sessionHandle = unwrapVariant(
    requireSuccess(created, "create a screen-sharing session")
      .results["session_handle"],
  );
  if (typeof sessionHandle !== "string" || sessionHandle.length === 0) {
    throw new CoreError(
      "the portal did not return a session handle",
      "unavailable",
    );
  }

  const restoreToken = options.store?.load();
  requireSuccess(
    await portalRequest(
      REMOTE_DESKTOP_INTERFACE,
      "SelectDevices",
      "oa{sv}",
      [sessionHandle],
      {
        types: connection.variant("u", DEVICE_KEYBOARD | DEVICE_POINTER),
        // Persistence lives here, not in Start: xdg-desktop-portal reads
        // both options from SelectDevices (remote_desktop_select_devices_
        // options) and turns the opaque token into the backend's restore
        // data itself. Start only takes the handle token — passing
        // persist_mode there is accepted and silently ignored, which costs
        // the restore token (measured).
        persist_mode: connection.variant("u", PERSISTENT),
        ...(restoreToken !== undefined
          ? { restore_token: connection.variant("s", restoreToken) }
          : {}),
      },
    ),
    "offer keyboard and pointer input",
  );
  requireSuccess(
    await portalRequest(
      SCREEN_CAST_INTERFACE,
      "SelectSources",
      "oa{sv}",
      [sessionHandle],
      {
        types: connection.variant("u", SOURCE_MONITOR),
        multiple: connection.variant("b", true),
        cursor_mode: connection.variant("u", CURSOR_EMBEDDED),
        // No persist_mode here either: mutter refuses it for a session
        // created through RemoteDesktop ("Remote desktop sessions cannot
        // persist", measured).
      },
    ),
    "select the monitors to share",
  );

  const started = await portalRequest(
    REMOTE_DESKTOP_INTERFACE,
    "Start",
    "osa{sv}",
    [
      sessionHandle,
      // No parent window: the consent dialog is then shown on its own,
      // which is what a background server can offer.
      "",
    ],
  );
  const shared = requireSuccess(started, "share the screen");
  const streams = parseStreams(shared.results["streams"]);
  if (streams.length === 0) {
    throw new CoreError(
      "the desktop shared no monitor: pick at least one monitor in the " +
        "screen-sharing dialog",
      "unavailable",
    );
  }
  const nextToken = unwrapVariant(shared.results["restore_token"]);
  if (typeof nextToken === "string" && nextToken.length > 0) {
    options.store?.save(nextToken);
  }

  const notify = async (
    member: string,
    signature: string,
    body: unknown[],
  ): Promise<void> => {
    await connection.call({
      destination: PORTAL_DESTINATION,
      path: PORTAL_PATH,
      interface: REMOTE_DESKTOP_INTERFACE,
      member,
      signature: `oa{sv}${signature}`,
      body: [sessionHandle, {}, ...body],
    });
  };

  return {
    streams,
    ...(typeof nextToken === "string" && nextToken.length > 0
      ? { restoreToken: nextToken }
      : {}),
    async pointerMotionAbsolute(streamId, x, y) {
      await notify("NotifyPointerMotionAbsolute", "udd", [streamId, x, y]);
    },
    async pointerButton(button, pressed) {
      await notify("NotifyPointerButton", "iu", [
        BUTTON_CODES[button],
        pressed ? PRESSED : RELEASED,
      ]);
    },
    async pointerAxisDiscrete(axis, steps) {
      await notify("NotifyPointerAxisDiscrete", "ui", [
        axis === "vertical" ? 0 : 1,
        steps,
      ]);
    },
    async keyboardKeysym(keysym, pressed) {
      await notify("NotifyKeyboardKeysym", "iu", [
        keysym,
        pressed ? PRESSED : RELEASED,
      ]);
    },
    async close() {
      try {
        await connection.call({
          destination: PORTAL_DESTINATION,
          path: sessionHandle,
          interface: SESSION_INTERFACE,
          member: "Close",
          signature: "",
          body: [],
        });
      } catch {
        // The session may already be gone (the user closed it, the
        // compositor restarted); closing twice is not an error.
      }
    },
  };
}

/** Turn a non-zero response into the error that names what the user did. */
function requireSuccess(outcome: RequestOutcome, what: string): RequestOutcome {
  if (outcome.response === 0) return outcome;
  if (outcome.response === 1) {
    throw new CoreError(
      `the user cancelled the request to ${what}; ask them to allow it and ` +
        "try again",
      "unavailable",
    );
  }
  throw new CoreError(
    `the request to ${what} failed (portal response ${outcome.response}); ` +
      "a consent dialog that is never answered gives up after about 25 " +
      "seconds",
    "unavailable",
  );
}

/** `a(ua{sv})`: one entry per shared monitor. */
function parseStreams(value: unknown): PortalStream[] {
  const list = unwrapVariant(value);
  if (!Array.isArray(list)) {
    throw new CoreError(
      "the portal reported its streams in an unexpected shape",
      "unavailable",
    );
  }
  return list.map((entry) => {
    const fields = Array.isArray(entry) ? entry : [];
    const id = unwrapVariant(fields[0]);
    const properties = unwrapVariant(fields[1]);
    const record = typeof properties === "object" && properties !== null
      ? properties as Record<string, unknown>
      : {};
    const position = tuple(record["position"]);
    const size = tuple(record["size"]);
    // mutter publishes "output-name" (the connector, e.g. "Virtual-1");
    // the spec's own "id" is the fallback so another compositor still has a
    // name to match a monitor with.
    const connectors = [record["output-name"], record["id"]]
      .map(unwrapVariant)
      .filter((name): name is string =>
        typeof name === "string" && name.length > 0
      );
    if (typeof id !== "number") {
      throw new CoreError(
        "the portal reported a stream without an id",
        "unavailable",
      );
    }
    return {
      id,
      connectors,
      position: { x: position[0] ?? 0, y: position[1] ?? 0 },
      size: { width: size[0] ?? 0, height: size[1] ?? 0 },
    };
  });
}

function tuple(value: unknown): number[] {
  const list = unwrapVariant(value);
  if (!Array.isArray(list)) return [];
  return list.map(unwrapVariant).filter((entry): entry is number =>
    typeof entry === "number"
  );
}
