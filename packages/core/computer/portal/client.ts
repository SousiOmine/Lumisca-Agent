/**
 * The portal client the Wayland host drives, and the non-interactive probe
 * that decides whether this machine can be driven at all.
 *
 * The probe asks only for things that cannot open a dialog: interface
 * properties, the portal's presence, and the monitor layout. Taking a
 * screenshot and sharing the screen both ask the user, so they happen on
 * first use instead of at server startup — a server that popped a consent
 * dialog while it booted would be its own kind of hostile.
 */
import { errorMessage } from "../../errors.ts";
import {
  connectPortalBus,
  type PortalConnection,
  unwrapVariant,
} from "./connection.ts";
import { readMonitorLayout } from "./display-config.ts";
import {
  DEVICE_KEYBOARD,
  DEVICE_POINTER,
  openRemoteDesktopSession,
  REMOTE_DESKTOP_INTERFACE,
} from "./remote-desktop.ts";
import {
  captureScreen,
  PORTAL_DESTINATION,
  PORTAL_PATH,
  SCREENSHOT_INTERFACE,
} from "./screenshot.ts";
import type {
  MonitorLayout,
  PortalClient,
  RestoreTokenStore,
} from "./types.ts";

/** `NotifyKeyboardKeysym`, which typing needs, arrived with version 2 of the
 * RemoteDesktop portal (xdg-desktop-portal 1.18 / GNOME 41 and later). */
export const REQUIRED_REMOTE_DESKTOP_VERSION = 2;

const PROPERTIES_INTERFACE = "org.freedesktop.DBus.Properties";

export interface PortalProbeOptions {
  /** Where a screen-sharing restore token is kept. Without it every session
   * asks the user again. */
  store?: RestoreTokenStore;
  /** How long one consent dialog may wait for the user. */
  requestTimeoutMs?: number;
  env?: { get(key: string): string | undefined };
}

export type PortalProbeResult =
  | { available: true; client: PortalClient; layout: MonitorLayout }
  | { available: false; reason: string };

/** Open the session bus and check that it offers what the host needs. The
 * connection is closed again on every failure path: an unavailable machine
 * must not leave a socket behind. */
export async function probePortal(
  options: PortalProbeOptions = {},
): Promise<PortalProbeResult> {
  let connection: PortalConnection;
  try {
    connection = await connectPortalBus(options.env);
  } catch (error) {
    return { available: false, reason: errorMessage(error) };
  }
  const unavailable = (reason: string): PortalProbeResult => {
    connection.disconnect();
    return { available: false, reason };
  };

  try {
    const version = await property(
      connection,
      REMOTE_DESKTOP_INTERFACE,
      "version",
    );
    if (
      typeof version !== "number" ||
      version < REQUIRED_REMOTE_DESKTOP_VERSION
    ) {
      return unavailable(
        `the desktop's RemoteDesktop portal is too old for keyboard input ` +
          `(version ${version ?? "?"}, needs ` +
          `${REQUIRED_REMOTE_DESKTOP_VERSION})`,
      );
    }
    const devices = await property(
      connection,
      REMOTE_DESKTOP_INTERFACE,
      "AvailableDeviceTypes",
    );
    const needed = DEVICE_KEYBOARD | DEVICE_POINTER;
    if (typeof devices !== "number" || (devices & needed) !== needed) {
      return unavailable(
        "this desktop does not offer keyboard and pointer input through " +
          "the portal",
      );
    }
    await property(connection, SCREENSHOT_INTERFACE, "version");
  } catch (error) {
    return unavailable(
      `the desktop portal (${PORTAL_DESTINATION}) is not answering: ` +
        errorMessage(error),
    );
  }

  let layout: MonitorLayout;
  try {
    layout = await readMonitorLayout(connection);
  } catch (error) {
    return unavailable(
      "this desktop does not publish a monitor layout " +
        "(org.gnome.Mutter.DisplayConfig), which is what maps screenshots " +
        `and clicks to monitors: ${errorMessage(error)}`,
    );
  }

  return {
    available: true,
    layout,
    client: {
      monitorLayout: () => readMonitorLayout(connection),
      captureScreen: () => captureScreen(connection, options.requestTimeoutMs),
      openSession: () =>
        openRemoteDesktopSession({
          connection,
          store: options.store,
          timeoutMs: options.requestTimeoutMs,
        }),
      disconnect: () => connection.disconnect(),
    },
  };
}

/** Read one interface property, with its variant unwrapped. */
async function property(
  connection: PortalConnection,
  interfaceName: string,
  name: string,
): Promise<unknown> {
  const reply = await connection.call({
    destination: PORTAL_DESTINATION,
    path: PORTAL_PATH,
    interface: PROPERTIES_INTERFACE,
    member: "Get",
    signature: "ss",
    body: [interfaceName, name],
  });
  return unwrapVariant(reply[0]);
}
