/**
 * org.gnome.Mutter.DisplayConfig, read-only: where the monitor layout and
 * the per-monitor scale come from.
 *
 * Two facts make this interface necessary rather than a convenience:
 *
 * - A screen-cast stream's metadata carries the monitor's position and size
 *   in the compositor's logical space but NOT its scale, while
 *   `NotifyPointerMotionAbsolute` takes the stream's physical pixel grid
 *   (mutter converts with `logical = monitor + stream / monitor.scale`). A
 *   mixed-DPI desktop therefore cannot be clicked accurately without the
 *   scale, and nothing else on the bus publishes it.
 * - The whole desktop has to be known before the user has shared anything,
 *   because `computer_screenshot` may capture any monitor — and taking a
 *   screenshot must not require a screen-cast session.
 *
 * The interface is mutter's own (GNOME Settings reads it), so this module is
 * GNOME-specific by nature: a desktop without it reports the reason instead
 * of guessing coordinates.
 *
 * GetCurrentState answers with `(u serial, a monitors, a logical monitors,
 * a{sv} properties)`. A logical monitor entry is `(i x, i y, d scale, u
 * transform, b primary, a(ssa{sv}) monitors, a{sv} properties)` and does NOT
 * carry its size: the size is the current mode of the monitor it names,
 * divided by the scale.
 */
import { CoreError } from "../../errors.ts";
import type { PortalConnection } from "./connection.ts";
import type { LogicalMonitor, MonitorLayout } from "./types.ts";

export const DISPLAY_CONFIG_DESTINATION = "org.gnome.Mutter.DisplayConfig";
export const DISPLAY_CONFIG_PATH = "/org/gnome/Mutter/DisplayConfig";
export const DISPLAY_CONFIG_INTERFACE = "org.gnome.Mutter.DisplayConfig";

interface ModeSize {
  width: number;
  height: number;
}

/** The whole desktop as the compositor lays it out. */
export async function readMonitorLayout(
  connection: PortalConnection,
): Promise<MonitorLayout> {
  const reply = await connection.call({
    destination: DISPLAY_CONFIG_DESTINATION,
    path: DISPLAY_CONFIG_PATH,
    interface: DISPLAY_CONFIG_INTERFACE,
    member: "GetCurrentState",
    signature: "",
    body: [],
  });
  const modeSizes = parseMonitorModes(
    asArray(reply[1], "the monitors"),
  );
  const entries = asArray(reply[2], "the logical monitors");
  const monitors: LogicalMonitor[] = entries.map((entry, index) =>
    parseLogicalMonitor(entry, index, modeSizes)
  );
  if (monitors.length === 0) {
    throw new CoreError("the compositor reported no monitors", "unavailable");
  }
  // Left to right, then top to bottom: the indices a caller saw stay the
  // same between calls as long as the arrangement does.
  monitors.sort((a, b) => a.x - b.x || a.y - b.y);
  const minX = Math.min(...monitors.map((monitor) => monitor.x));
  const minY = Math.min(...monitors.map((monitor) => monitor.y));
  const maxX = Math.max(
    ...monitors.map((monitor) => monitor.x + monitor.width),
  );
  const maxY = Math.max(
    ...monitors.map((monitor) => monitor.y + monitor.height),
  );
  return {
    monitors,
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

/** `primary 1920×1080 at (-1280, 0) scale 2 [Virtual-1]`. */
export function describeMonitor(monitor: LogicalMonitor): string {
  const connectors = monitor.connectors.length > 0
    ? ` [${monitor.connectors.join(", ")}]`
    : "";
  return `${monitor.primary ? "primary " : ""}${monitor.width}×` +
    `${monitor.height} at (${monitor.x}, ${monitor.y}) scale ` +
    `${monitor.scale}${connectors}`;
}

/** The size of each monitor's current mode, keyed by connector. */
function parseMonitorModes(
  monitors: readonly unknown[],
): Map<string, ModeSize> {
  const sizes = new Map<string, ModeSize>();
  for (const monitor of monitors) {
    const parts = asArray(monitor, "monitor");
    const connector = asString(
      asArray(parts[0], "monitor name")[0],
      "monitor connector",
    );
    const modes = asArray(parts[1], "monitor modes");
    const mode = currentMode(modes) ?? modes[0];
    if (mode === undefined) continue;
    const fields = asArray(mode, "mode");
    sizes.set(connector, {
      width: asNumber(fields[1], "mode width"),
      height: asNumber(fields[2], "mode height"),
    });
  }
  return sizes;
}

/** The mode the monitor currently runs: mutter flags it `is-current`, and
 * falls back to the first (preferred) mode when the flag is missing. */
function currentMode(modes: readonly unknown[]): unknown | undefined {
  return modes.find((mode) => {
    const properties = Array.isArray(mode) ? mode[6] : undefined;
    return isRecord(properties) && properties["is-current"] !== undefined;
  });
}

/** One `(iiduba(ssa{sv})a{sv})` entry of GetCurrentState. */
function parseLogicalMonitor(
  entry: unknown,
  index: number,
  modeSizes: Map<string, ModeSize>,
): LogicalMonitor {
  const fields = asArray(entry, `logical monitor ${index}`);
  const x = asNumber(fields[0], `logical monitor ${index} x`);
  const y = asNumber(fields[1], `logical monitor ${index} y`);
  const scale = asNumber(fields[2], `logical monitor ${index} scale`);
  const primary = asBoolean(fields[4], `logical monitor ${index} primary`);
  const connectors = asArray(
    fields[5],
    `logical monitor ${index} monitors`,
  ).map((monitor) =>
    asString(
      asArray(monitor, `logical monitor ${index} monitor`)[0],
      `logical monitor ${index} connector`,
    )
  );
  const size = connectors
    .map((connector) => modeSizes.get(connector))
    .find((candidate) => candidate !== undefined);
  if (size === undefined) {
    throw new CoreError(
      `the compositor reported monitor ${connectors.join(", ")} without a ` +
        "current mode",
      "unavailable",
    );
  }
  const effectiveScale = scale > 0 ? scale : 1;
  return {
    x,
    y,
    // Mutter divides the mode size by the scale and rounds; a fractional
    // scale can therefore land one pixel off the exact quotient.
    width: Math.round(size.width / effectiveScale),
    height: Math.round(size.height / effectiveScale),
    scale: effectiveScale,
    primary,
    connectors,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new CoreError(
      `the compositor's layout is not what this version expects (${what})`,
      "unavailable",
    );
  }
  return value;
}

function asNumber(value: unknown, what: string): number {
  if (typeof value !== "number") {
    throw new CoreError(
      `the compositor's layout is not what this version expects (${what})`,
      "unavailable",
    );
  }
  return value;
}

function asBoolean(value: unknown, what: string): boolean {
  if (typeof value !== "boolean") {
    throw new CoreError(
      `the compositor's layout is not what this version expects (${what})`,
      "unavailable",
    );
  }
  return value;
}

function asString(value: unknown, what: string): string {
  if (typeof value !== "string") {
    throw new CoreError(
      `the compositor's layout is not what this version expects (${what})`,
      "unavailable",
    );
  }
  return value;
}
