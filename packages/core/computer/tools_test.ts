import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  COMPUTER_TOOL_NAMES,
  createComputerTools,
  MAX_TYPE_CHARS,
  MAX_WAIT_MS,
  MAX_WINDOW_LINES,
} from "./tools.ts";
import type {
  ComputerAction,
  ComputerActionResult,
  ComputerHost,
  DisplayInfo,
  Point,
  RawCapture,
  Rect,
  WindowInfo,
} from "./types.ts";
import {
  TOOL_COMPUTER_ACT,
  TOOL_COMPUTER_LIST_WINDOWS,
  TOOL_COMPUTER_SCREENSHOT,
} from "../shared/mod.ts";
import { toolText } from "../test-utils.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { createToolSearchTool } from "../tools/search-tool.ts";
import { createToolCallTool } from "../tools/call-tool.ts";

/** A host that records what it was asked to do and serves tiny frames.
 * Deliberately small (256×144): the tool layer's own scaling is what the
 * tests exercise, not the host's pixel copying. */
class FakeHost implements ComputerHost {
  readonly captures: Rect[] = [];
  readonly actions: ComputerAction[] = [];
  cursorAt: Point = { x: 5, y: 7 };
  displayList: DisplayInfo[] = [
    {
      index: 0,
      primary: true,
      bounds: { x: 0, y: 0, width: 256, height: 144 },
    },
    {
      index: 1,
      primary: false,
      bounds: { x: 256, y: 0, width: 192, height: 108 },
    },
  ];
  windowList: WindowInfo[] = [
    {
      id: "0x00000001",
      title: "index.html - Visual Studio Code",
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      focused: true,
      visible: true,
      minimized: false,
    },
    {
      id: "0x00000002",
      title: "メモ帳",
      bounds: { x: 256, y: 0, width: 400, height: 300 },
      focused: false,
      visible: true,
      minimized: false,
    },
  ];

  describe(): string {
    return "fake, 256×144 primary";
  }

  displays(): DisplayInfo[] {
    return this.displayList;
  }

  cursor(): Point {
    return this.cursorAt;
  }

  windows(): WindowInfo[] {
    return this.windowList;
  }

  capture(region: Rect): Promise<RawCapture> {
    this.captures.push(region);
    return Promise.resolve({
      screen: region,
      pixels: new Uint8Array(region.width * region.height * 4).fill(120),
      width: region.width,
      height: region.height,
    });
  }

  act(action: ComputerAction): Promise<ComputerActionResult> {
    this.actions.push(action);
    const mouse = action.kind === "move" || action.kind === "click" ||
      action.kind === "drag" || action.kind === "scroll";
    return Promise.resolve({
      cursor: this.cursorAt,
      steps: mouse ? 8 : 0,
      durationMs: mouse ? 104 : 5,
      ...(action.kind === "type" || action.kind === "key" ||
          action.kind === "focus_window"
        ? { window: this.windowList[0]! }
        : {}),
    });
  }

  close(): void {
    // nothing to release
  }
}

/** The tool family over a host (or no host at all). */
function tools(host: ComputerHost | undefined) {
  const byName = new Map(
    createComputerTools({ resolveHost: () => host }).map((tool) => [
      tool.name,
      tool,
    ]),
  );
  return {
    screenshot: byName.get(TOOL_COMPUTER_SCREENSHOT)!,
    act: byName.get(TOOL_COMPUTER_ACT)!,
    windows: byName.get(TOOL_COMPUTER_LIST_WINDOWS)!,
  };
}

// --- the family -------------------------------------------------------------

Deno.test("the computer family is exactly the three documented tools", () => {
  const family = tools(new FakeHost());
  assertEquals(
    [family.screenshot.name, family.act.name, family.windows.name],
    [...COMPUTER_TOOL_NAMES],
  );
  assertEquals([...COMPUTER_TOOL_NAMES], [
    TOOL_COMPUTER_SCREENSHOT,
    TOOL_COMPUTER_ACT,
    TOOL_COMPUTER_LIST_WINDOWS,
  ]);
});

/** Assert that a tool call fails, whether it throws synchronously or
 * rejects (the tools are a mix of both shapes). */
function rejectsWith(
  call: () => Promise<unknown>,
  message: string,
): Promise<unknown> {
  return assertRejects(
    () => Promise.resolve().then(call),
    Error,
    message,
  );
}

Deno.test("every tool fails clearly when no host is attached", async () => {
  const family = tools(undefined);
  await rejectsWith(
    () => family.screenshot.execute("id", {}),
    "not available in this session",
  );
  await rejectsWith(
    () => family.act.execute("id", { action: "wait", duration_ms: 1 }),
    "not available in this session",
  );
  await rejectsWith(
    () => family.windows.execute("id", {}),
    "not available in this session",
  );
});

// --- computer_screenshot ----------------------------------------------------

Deno.test("screenshot captures the primary display and states the mapping", async () => {
  const host = new FakeHost();
  const result = await tools(host).screenshot.execute("id", {});
  // The primary display's bounds are what the host was asked for.
  assertEquals(host.captures, [{ x: 0, y: 0, width: 256, height: 144 }]);
  const text = toolText(result);
  assert(text.includes("display 0 (primary): screen 256×144"), text);
  assert(text.includes("image 256×144 (scale 1.000)"), text);
  assert(text.includes("Cursor at screen (5, 7)."), text);
  assert(
    text.includes(
      "Displays: 0 (primary) 256×144 at (0, 0) ← captured | 1 192×108 at (256, 0)",
    ),
    text,
  );
  assert(
    text.includes(
      "computer_act coordinates are pixels of THIS image: screen = " +
        "round(image / 1.000) + (0, 0).",
    ),
    text,
  );
  const images = result.content.filter((block) => block.type === "image");
  assertEquals(images.length, 1);
  assertEquals(images[0]!.type === "image" && images[0]!.mimeType, "image/png");
  assertEquals(result.details["display"], 0);
  assertEquals(result.details["screen"], {
    x: 0,
    y: 0,
    width: 256,
    height: 144,
  });
  assertEquals(result.details["image"], { width: 256, height: 144 });
  assertEquals(result.details["scale"], 1);
});

Deno.test("screenshot scales to max_dimension and reports the exact scale", async () => {
  const host = new FakeHost();
  const result = await tools(host).screenshot.execute("id", {
    max_dimension: 128,
  });
  assertEquals(result.details["image"], { width: 128, height: 72 });
  assertEquals(result.details["scale"], 0.5);
  const text = toolText(result);
  assert(text.includes("image 128×72 (scale 0.500)"), text);
  assert(text.includes("round(image / 0.500) + (0, 0)"), text);
});

Deno.test("screenshot resolves a display index", async () => {
  const host = new FakeHost();
  const result = await tools(host).screenshot.execute("id", { display: 1 });
  assertEquals(host.captures, [{ x: 256, y: 0, width: 192, height: 108 }]);
  const text = toolText(result);
  assert(text.includes("display 1: screen 192×108 at (256, 0)"), text);
  assert(text.includes("1 192×108 at (256, 0) ← captured"), text);
  assertEquals(result.details["display"], 1);
});

Deno.test("screenshot captures an explicit region and keeps its origin", async () => {
  const host = new FakeHost();
  const result = await tools(host).screenshot.execute("id", {
    region: { x: 100, y: 50, width: 80, height: 40 },
  });
  assertEquals(host.captures, [{ x: 100, y: 50, width: 80, height: 40 }]);
  const text = toolText(result);
  assert(text.includes("region 80×40 at screen (100, 50)"), text);
  assert(text.includes("round(image / 1.000) + (100, 50)"), text);
  assertEquals(result.details["display"], undefined);
});

Deno.test("screenshot refuses unknown displays and regions off every display", async () => {
  const host = new FakeHost();
  const family = tools(host);
  await assertRejects(
    () => family.screenshot.execute("id", { display: 7 }),
    Error,
    "unknown display index 7 (this machine has 2 display(s): 0, 1)",
  );
  await assertRejects(
    () =>
      family.screenshot.execute("id", {
        region: { x: 5000, y: 5000, width: 10, height: 10 },
      }),
    Error,
    "does not overlap any display",
  );
});

Deno.test("screenshot validates max_dimension and the region size", async () => {
  const family = tools(new FakeHost());
  for (const maxDimension of [0, 63, 4097, 1.5]) {
    await assertRejects(
      () => family.screenshot.execute("id", { max_dimension: maxDimension }),
      Error,
      "max_dimension must be an integer",
      `max_dimension ${maxDimension} must be refused`,
    );
  }
  await assertRejects(
    () =>
      family.screenshot.execute("id", {
        region: { x: 0, y: 0, width: 0, height: 10 },
      }),
    Error,
    "out of range",
  );
  await assertRejects(
    () =>
      family.screenshot.execute("id", {
        region: { x: 0.5, y: 0, width: 10, height: 10 },
      }),
    Error,
    "region.x must be an integer",
  );
});

// --- computer_act -----------------------------------------------------------

Deno.test("act converts image coordinates through the last screenshot", async () => {
  const host = new FakeHost();
  const family = tools(host);
  await family.screenshot.execute("id", { max_dimension: 128 }); // scale 0.5
  const result = await family.act.execute("id", {
    action: "click",
    x: 64,
    y: 36,
  });
  // 64 / 0.5 = 128, 36 / 0.5 = 72 — the screen coordinates the host sees.
  assertEquals(host.actions, [{
    kind: "click",
    x: 128,
    y: 72,
    button: "left",
    count: 1,
  }]);
  const text = toolText(result);
  assert(
    text.includes("clicked left at screen (128, 72) in 8 steps (104ms)."),
    text,
  );
  assert(text.includes("image (64, 36) → screen (128, 72)"), text);
  assert(text.includes("Cursor now at screen (5, 7)."), text);
  assertEquals(result.details["image"], { x: 64, y: 36 });
  assertEquals(result.details["screen"], { x: 128, y: 72 });
});

Deno.test("act maps coordinates of a region capture through its origin", async () => {
  const host = new FakeHost();
  const family = tools(host);
  await family.screenshot.execute("id", {
    region: { x: 100, y: 50, width: 80, height: 40 },
  });
  await family.act.execute("id", { action: "move", x: 10, y: 20 });
  assertEquals(host.actions, [{ kind: "move", x: 110, y: 70 }]);
});

Deno.test("act refuses coordinate actions before any screenshot", async () => {
  const family = tools(new FakeHost());
  const coordinateActions: Array<Record<string, number | string>> = [
    { action: "move", x: 1, y: 2 },
    { action: "click", x: 1, y: 2 },
    { action: "drag", x: 1, y: 2, to_x: 3, to_y: 4 },
    { action: "scroll", x: 1, y: 2, delta_y: 1 },
  ];
  for (const params of coordinateActions) {
    await assertRejects(
      () => family.act.execute("id", params as never),
      Error,
      "no screenshot yet",
      `${params.action} must need a view`,
    );
  }
});

Deno.test("act forwards every action kind to the host", async () => {
  const host = new FakeHost();
  const family = tools(host);
  await family.screenshot.execute("id", {});

  await family.act.execute("id", {
    action: "drag",
    x: 10,
    y: 20,
    to_x: 30,
    to_y: 40,
    button: "right",
  });
  await family.act.execute("id", {
    action: "scroll",
    x: 5,
    y: 6,
    delta_y: 3,
  });
  await family.act.execute("id", { action: "type", text: "こんにちは" });
  await family.act.execute("id", { action: "key", key: "ctrl+shift+s" });
  await family.act.execute("id", {
    action: "focus_window",
    window: "0x00000002",
  });
  await family.act.execute("id", { action: "wait", duration_ms: 250 });

  assertEquals(host.actions, [
    {
      kind: "drag",
      from: { x: 10, y: 20 },
      to: { x: 30, y: 40 },
      button: "right",
    },
    { kind: "scroll", x: 5, y: 6, deltaX: 0, deltaY: 3 },
    { kind: "type", text: "こんにちは" },
    { kind: "key", key: "ctrl+shift+s" },
    { kind: "focus_window", window: "0x00000002" },
    { kind: "wait", durationMs: 250 },
  ]);
});

Deno.test("act reports the focused window for keyboard actions", async () => {
  const host = new FakeHost();
  const family = tools(host);
  const typed = await family.act.execute("id", { action: "type", text: "hi" });
  const text = toolText(typed);
  assert(text.includes("typed 2 character(s)."), text);
  assert(
    text.includes(
      'Focused window: 0x00000001 "index.html - Visual Studio Code" ' +
        "800×600 at (0, 0) focused.",
    ),
    text,
  );
  // No pointer line for typing: the pointer did not move.
  assertEquals(text.includes("Cursor now at"), false);
  assertEquals(typed.details["window"], "0x00000001");
  assertEquals(typed.details["windowTitle"], "index.html - Visual Studio Code");
});

Deno.test("act validates its arguments", async () => {
  const family = tools(new FakeHost());
  const act = (params: Record<string, unknown>) =>
    family.act.execute("id", params as never);

  await assertRejects(() => act({ action: "nope" }), Error, "unknown action");
  await assertRejects(
    () => act({ action: "wait" }),
    Error,
    "duration_ms must be an integer",
  );
  await assertRejects(
    () => act({ action: "wait", duration_ms: MAX_WAIT_MS + 1 }),
    Error,
    "duration_ms must be 0..",
  );
  await assertRejects(
    () => act({ action: "type", text: "" }),
    Error,
    "non-empty text",
  );
  await assertRejects(
    () => act({ action: "type", text: "x".repeat(MAX_TYPE_CHARS + 1) }),
    Error,
    "too long",
  );
  await assertRejects(
    () => act({ action: "key" }),
    Error,
    "key needs a key name",
  );
  await assertRejects(
    () => act({ action: "focus_window" }),
    Error,
    "needs a window id",
  );
  await assertRejects(
    () => act({ action: "click", x: 1, y: 2, button: "side" }),
    Error,
    'unknown button "side"',
  );
  await assertRejects(
    () => act({ action: "click", x: 1, y: 2, count: 3 }),
    Error,
    "count must be 1 or 2",
  );
  await assertRejects(
    () => act({ action: "click", x: 1 }),
    Error,
    "y must be an integer",
  );
  await assertRejects(
    () => act({ action: "scroll", x: 1, y: 2 }),
    Error,
    "needs delta_x and/or delta_y",
  );
});

// --- computer_list_windows --------------------------------------------------

Deno.test("list_windows formats the z-order list and filters by title", async () => {
  const host = new FakeHost();
  const family = tools(host);
  const all = toolText(await family.windows.execute("id", {}));
  assert(all.startsWith("2 window(s), z-order (topmost first):"), all);
  assert(
    all.includes(
      '0x00000001 "index.html - Visual Studio Code" 800×600 at (0, 0) focused',
    ),
    all,
  );
  assert(all.includes('0x00000002 "メモ帳" 400×300 at (256, 0)'), all);

  const filtered = await family.windows.execute("id", {
    title_contains: "メモ",
  });
  assertEquals(
    toolText(filtered),
    '1 window(s), z-order (topmost first):\n0x00000002 "メモ帳" 400×300 at (256, 0)',
  );
  assertEquals(filtered.details["windows"], 1);
  assertEquals(filtered.details["total"], 2);

  const none = await family.windows.execute("id", { title_contains: "nope" });
  assertEquals(
    toolText(none),
    'No window title contains "nope" (2 window(s) open).',
  );
});

Deno.test("list_windows announces the windows it did not list", async () => {
  const host = new FakeHost();
  host.windowList = Array.from(
    { length: MAX_WINDOW_LINES + 7 },
    (_, i) => ({
      id: `0x${(i + 1).toString(16).padStart(8, "0")}`,
      title: `window ${i}`,
      bounds: { x: 0, y: 0, width: 100, height: 100 },
      focused: false,
      visible: true,
      minimized: false,
    }),
  );
  const text = toolText(await tools(host).windows.execute("id", {}));
  const lines = text.split("\n");
  assertEquals(lines.length, 1 + MAX_WINDOW_LINES + 1);
  assertEquals(
    lines.at(-1),
    "… (+7 more; narrow the list with title_contains)",
  );
});

// --- registry contract ------------------------------------------------------

Deno.test("the tools are discoverable via tool_search and callable via tool_call", async () => {
  const host = new FakeHost();
  const registry = new ToolRegistry();
  registry.addTools(
    createComputerTools({ resolveHost: () => host }),
  );
  const search = createToolSearchTool(() => registry);
  const found = toolText(await search.execute("search", { query: "computer" }));
  assert(found.includes(TOOL_COMPUTER_SCREENSHOT), found);
  assert(found.includes(TOOL_COMPUTER_ACT), found);
  assert(found.includes(TOOL_COMPUTER_LIST_WINDOWS), found);
  // The search result carries the argument schema, which is how the model
  // builds the call without ever having seen the definition.
  assert(found.includes("Arguments (JSON Schema)"), found);

  const call = createToolCallTool(() => registry);
  const result = await call.execute("call", {
    name: TOOL_COMPUTER_SCREENSHOT,
    args: {},
  });
  const text = toolText(result);
  assert(text.startsWith(`[${TOOL_COMPUTER_SCREENSHOT}]`), text);
  assert(text.includes("image 256×144"), text);
  // The image block survives the dispatch, so the model still sees pixels.
  assertEquals(
    result.content.filter((block) => block.type === "image").length,
    1,
  );
});
