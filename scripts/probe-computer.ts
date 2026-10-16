/**
 * Manual probe for computer use: probes this machine's host, prints what it
 * reports, takes one screenshot and — when asked — performs one action.
 *
 * It exists because the interesting parts of the Linux path cannot be
 * asserted in a unit test: the desktop asks the user for permission the
 * first time a screenshot is taken and the first time input is injected, and
 * only a person can answer. Everything here is an ordinary host call, so
 * what it prints is what the agent will see.
 *
 * The capture is written as `probe-computer.png` in the working directory,
 * and the coordinates for --move/--click are IMAGE pixels of that file —
 * exactly the conversion the computer_screenshot/computer_act tools do — so
 * a point read off the PNG can be clicked directly.
 *
 * Run from the repository root:
 *   deno task probe:computer
 *   deno task probe:computer --click 640,360
 *   deno task probe:computer --move 100,100 --type "hello"
 *   deno task probe:computer --key "ctrl+shift+s"
 */
import { createComputerHost } from "../packages/core/computer/host.ts";
import {
  DEFAULT_MAX_DIMENSION,
  encodeCapture,
} from "../packages/core/computer/image.ts";
import type { ComputerAction } from "../packages/core/computer/types.ts";
import type { RestoreTokenStore } from "../packages/core/computer/portal/types.ts";

const IMAGE_FILE = "probe-computer.png";
/** The screen-sharing permission (the portal's restore token) is kept here
 * between runs, the way the server keeps it in its settings table: without
 * a store every run would ask the user again, and a granted share that
 * survives a restart could never be observed. */
const TOKEN_FILE = ".lumisca-cache/probe-session-token";

const tokenStore: RestoreTokenStore = {
  load: () => {
    try {
      const token = Deno.readTextFileSync(TOKEN_FILE).trim();
      return token.length > 0 ? token : undefined;
    } catch {
      return undefined;
    }
  },
  save: (token) => {
    try {
      Deno.mkdirSync(".lumisca-cache", { recursive: true });
      Deno.writeTextFileSync(TOKEN_FILE, token);
    } catch {
      // A probe that cannot remember the permission still works; it just
      // asks again next time.
    }
  },
};

function usage(): never {
  console.log(
    [
      "usage: deno task probe:computer [options]",
      "",
      "  --move x,y     move the pointer to an image pixel of the capture",
      "  --click x,y    click (left) at an image pixel of the capture",
      "  --type text    type text at the current focus",
      '  --key chord    press a key or chord, e.g. "enter" or "ctrl+shift+s"',
      "  --wait ms      wait before the action",
      "",
      "Only one action is performed, and only when a flag asks for it.",
    ].join("\n"),
  );
  Deno.exit(2);
}

/** Parse `x,y` into image coordinates. */
function point(value: string, flag: string): { x: number; y: number } {
  const parts = value.split(",");
  const x = Number(parts[0]);
  const y = Number(parts[1]);
  if (parts.length !== 2 || !Number.isFinite(x) || !Number.isFinite(y)) {
    console.error(`${flag} expects "x,y" (got "${value}")`);
    Deno.exit(2);
  }
  return { x, y };
}

const args = Deno.args;
let requested: { kind: string; value: string } | undefined;
for (let i = 0; i < args.length; i++) {
  const flag = args[i]!;
  if (flag === "--help" || flag === "-h") usage();
  if (!flag.startsWith("--")) {
    console.error(`unexpected argument "${flag}"`);
    usage();
  }
  const value = args[i + 1];
  if (value === undefined) {
    console.error(`${flag} needs a value`);
    usage();
  }
  if (requested !== undefined) {
    console.error("one action at a time, please");
    usage();
  }
  requested = { kind: flag.slice(2), value };
  i++;
}

const host = await createComputerHost({ store: tokenStore });
if (!host.available) {
  console.error(`computer use is unavailable: ${host.reason}`);
  Deno.exit(1);
}

try {
  console.log(`host: ${host.host.describe()}`);
  console.log(`capabilities: ${JSON.stringify(host.host.capabilities)}`);
  const displays = host.host.displays();
  for (const display of displays) {
    console.log(
      `display ${display.index}${display.primary ? " (primary)" : ""}: ` +
        `${display.bounds.width}×${display.bounds.height} at ` +
        `(${display.bounds.x}, ${display.bounds.y})`,
    );
  }

  const primary = displays.find((display) => display.primary) ?? displays[0]!;
  const started = Date.now();
  const raw = await host.host.capture(primary.bounds);
  const encoded = encodeCapture(raw, DEFAULT_MAX_DIMENSION);
  await Deno.writeFile(IMAGE_FILE, encoded.png);
  console.log(
    `captured ${raw.screen.width}×${raw.screen.height} screen units as ` +
      `${raw.width}×${raw.height} pixels in ${Date.now() - started}ms`,
  );
  console.log(
    `image ${encoded.width}×${encoded.height} (scale ` +
      `${encoded.scale.toFixed(3)}) written to ${IMAGE_FILE}`,
  );
  console.log(
    `mapping: screen = round(image / ${encoded.scale.toFixed(3)}) + ` +
      `(${raw.screen.x}, ${raw.screen.y})`,
  );

  if (requested !== undefined) {
    const toScreen = (point: { x: number; y: number }) => ({
      x: Math.round(point.x / encoded.scale) + raw.screen.x,
      y: Math.round(point.y / encoded.scale) + raw.screen.y,
    });
    let action: ComputerAction;
    switch (requested.kind) {
      case "move": {
        const at = toScreen(point(requested.value, "--move"));
        action = { kind: "move", x: at.x, y: at.y };
        break;
      }
      case "click": {
        const at = toScreen(point(requested.value, "--click"));
        action = { kind: "click", x: at.x, y: at.y, button: "left", count: 1 };
        break;
      }
      case "type":
        action = { kind: "type", text: requested.value };
        break;
      case "key":
        action = { kind: "key", key: requested.value };
        break;
      case "wait":
        action = { kind: "wait", durationMs: Number(requested.value) };
        break;
      default:
        console.error(`unknown option --${requested.kind}`);
        usage();
    }
    console.log(`action: ${JSON.stringify(action)}`);
    const result = await host.host.act(action);
    console.log(
      `result: ${JSON.stringify(result)} (the first action opens the ` +
        "desktop's screen-sharing dialog)",
    );
  }
} finally {
  host.host.close();
}
