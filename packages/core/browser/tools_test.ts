import { assert, assertEquals, assertMatch } from "@std/assert";
import { createBrowserTools } from "./tools.ts";
import { createCodingTools } from "../tools/mod.ts";
import { Sandbox } from "../workspace/sandbox.ts";
import type { Workspace } from "../types/workspace.ts";
import type {
  ActionResult,
  BrowserBackend,
  ImageResult,
  PageInfo,
  PageSnapshot,
  WaitResult,
} from "./types.ts";
import {
  TOOL_BROWSER_ACT,
  TOOL_BROWSER_CLOSE,
  TOOL_BROWSER_OBSERVE,
  TOOL_BROWSER_OPEN,
  TOOL_BROWSER_SCREENSHOT,
  TOOL_BROWSER_WAIT,
} from "../shared.ts";

/** Run fn, return the thrown error (asserting one was thrown). */
async function expectThrow(fn: () => Promise<unknown>): Promise<Error> {
  try {
    await fn();
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error("expected the call to throw");
}

/** In-memory backend recording calls and serving canned replies. */
class FakeBackend implements BrowserBackend {
  calls: Array<{ method: string; args: unknown[] }> = [];
  closeCount = 0;

  constructor(
    private readonly replies: Record<string, unknown>,
  ) {}

  open(options: Parameters<BrowserBackend["open"]>[0]): Promise<PageInfo> {
    this.calls.push({ method: "open", args: [options] });
    return Promise.resolve(this.replies.open as PageInfo);
  }

  observe(
    options?: Parameters<BrowserBackend["observe"]>[0],
  ): Promise<PageSnapshot> {
    this.calls.push({
      method: "observe",
      args: options === undefined ? [] : [options],
    });
    return Promise.resolve(this.replies.observe as PageSnapshot);
  }

  act(action: Parameters<BrowserBackend["act"]>[0]): Promise<ActionResult> {
    this.calls.push({ method: "act", args: [action] });
    return Promise.resolve(this.replies.act as ActionResult);
  }

  wait(options: Parameters<BrowserBackend["wait"]>[0]): Promise<WaitResult> {
    this.calls.push({ method: "wait", args: [options] });
    return Promise.resolve(this.replies.wait as WaitResult);
  }

  screenshot(): Promise<ImageResult> {
    this.calls.push({ method: "screenshot", args: [] });
    return Promise.resolve(this.replies.screenshot as ImageResult);
  }

  close(): Promise<void> {
    this.closeCount++;
    return Promise.resolve();
  }
}

function toolMap() {
  const backend = new FakeBackend({});
  const tools = createBrowserTools(backend);
  const byName = new Map(tools.map((t) => [t.name, t]));
  return { backend, tools, byName };
}

function snapshot(): PageSnapshot {
  return {
    url: "http://127.0.0.1:5173/",
    title: "Test",
    readyState: "complete",
    viewport: { width: 1200, height: 800 },
    elements: [
      {
        ref: "e12",
        tag: "button",
        role: "button",
        name: "保存",
        disabled: false,
        visible: true,
        text: "保存",
      },
      {
        ref: "e13",
        tag: "input",
        role: "textbox",
        name: "ユーザー名",
        disabled: false,
        visible: true,
        inputType: "text",
        value: "alice",
      },
      {
        ref: "e14",
        tag: "a",
        role: "link",
        name: "ドキュメント",
        disabled: false,
        visible: false,
        href: "/docs",
      },
    ],
    pageText: "ようこそ",
    console: [{ level: "error", text: "boom" }],
    errors: [{ kind: "unhandledrejection", message: "rejected" }],
    network: { active: 0, completed: 3, failed: 1, idleMs: 12 },
    mutated: true,
    truncated: [],
  };
}

Deno.test("createBrowserTools provides exactly the six required tools", () => {
  const { byName } = toolMap();
  for (
    const name of [
      TOOL_BROWSER_OPEN,
      TOOL_BROWSER_OBSERVE,
      TOOL_BROWSER_ACT,
      TOOL_BROWSER_WAIT,
      TOOL_BROWSER_SCREENSHOT,
      TOOL_BROWSER_CLOSE,
    ]
  ) {
    assert(byName.has(name), `missing ${name}`);
  }
  assertEquals(byName.size, 6);
});

Deno.test("browser_open validates the URL against the policy and calls the backend", async () => {
  const { backend, byName } = toolMap();
  const backend2 = new FakeBackend({
    open: { url: "http://127.0.0.1:5173/", title: "T" },
  });
  const tools = createBrowserTools(backend2);
  const open = tools.find((t) => t.name === TOOL_BROWSER_OPEN)!;
  const result = await open.execute(
    "1",
    { url: "http://127.0.0.1:5173/" },
    undefined,
  );
  assertEquals(backend2.calls[0]?.method, "open");
  // The viewport defaults to 800×600 — the tool always sends explicit
  // values so the hosts never guess.
  assertEquals(backend2.calls[0]?.args[0], {
    url: "http://127.0.0.1:5173/",
    width: 800,
    height: 600,
  });
  assertMatch(
    result.content[0]!.type === "text" ? result.content[0]!.text : "",
    /Opened .* \(viewport 800×600\)/,
  );

  // Agent-specified sizes pass through as-is.
  await tools.find((t) => t.name === TOOL_BROWSER_OPEN)!.execute(
    "3",
    { url: "http://127.0.0.1:5173/", width: 390, height: 844 },
    undefined,
  );
  assertEquals(backend2.calls[1]?.args[0], {
    url: "http://127.0.0.1:5173/",
    width: 390,
    height: 844,
  });

  // Out-of-range sizes are rejected before reaching the backend.
  await assertMatch(
    (await expectThrow(() =>
      tools.find((t) => t.name === TOOL_BROWSER_OPEN)!.execute(
        "4",
        { url: "http://127.0.0.1:5173/", width: 0, height: 600 },
        undefined,
      )
    )).message,
    /width\/height は 1〜10000 の範囲/,
  );
  assertEquals(backend2.calls.length, 2);

  await assertMatch(
    (await expectThrow(() =>
      byName.get(TOOL_BROWSER_OPEN)!.execute("2", {
        url: "https://example.com/",
      }, undefined)
    )).message,
    /ローカルホスト/,
  );
  // The rejected URL must never reach the backend.
  assertEquals(backend.calls.length, 0);

  // Invalid widths are schema-level; width validation happens at build
  // time in the LLM layer, but the tool must still reject nonsense via
  // the schema. The DSL schema is plain JSON Schema — check its shape.
  const schema =
    (byName.get(TOOL_BROWSER_OPEN)!.parameters as { required: string[] })
      .required;
  assert(schema.includes("url"));
});

Deno.test("browser_observe formats the snapshot for the LLM", async () => {
  const backend = new FakeBackend({ observe: snapshot() });
  const tools = createBrowserTools(backend);
  const observe = tools.find((t) => t.name === TOOL_BROWSER_OBSERVE)!;
  const result = await observe.execute("1", {}, undefined);
  const text = result.content[0]!.type === "text"
    ? result.content[0]!.text
    : "";
  assertMatch(
    text,
    /Page: Test — http:\/\/127\.0\.0\.1:5173\/ \(complete · 1200×800\)/,
  );
  assertMatch(text, /button "保存" \[ref=e12\]/);
  assertMatch(text, /textbox "ユーザー名" \[ref=e13\] value="alice"/);
  assertMatch(text, /link "ドキュメント" \[ref=e14\] href=\/docs \(hidden\)/);
  assertMatch(text, /Console \(1 since last observe\):\s+error: boom/);
  assertMatch(text, /unhandledrejection: rejected/);
  assertMatch(
    text,
    /network: idle 12ms · 3 completed · 1 failed · DOM changed/,
  );
  assertEquals(result.details?.elementCount, 3);
});

Deno.test("browser_observe include_text=false skips the digest", async () => {
  const backend = new FakeBackend({ observe: snapshot() });
  const tools = createBrowserTools(backend);
  await tools.find((t) => t.name === TOOL_BROWSER_OBSERVE)!
    .execute("1", { include_text: false }, undefined);
  const callArgs = backend.calls[0]!.args[0] as { includeText: boolean };
  assertEquals(callArgs.includeText, false);
});

Deno.test("browser_act builds every action kind and throws on page failures", async () => {
  const okBackend = new FakeBackend({
    act: { ok: true, element: snapshot().elements[0] },
  });
  const tools = createBrowserTools(okBackend);
  const act = tools.find((t) => t.name === TOOL_BROWSER_ACT)!;

  for (
    const params of [
      { action: "click", ref: "e12" },
      { action: "fill", ref: "e13", value: "bob" },
      { action: "type", ref: "e13", value: "x" },
      { action: "press", ref: "e13", key: "Enter" },
      { action: "press", key: "Escape" },
      { action: "select", ref: "e15", value: "jp" },
      { action: "check", ref: "e16" },
      { action: "uncheck", ref: "e16" },
      { action: "scroll", ref: "e12" },
      { action: "scroll", x: 0, y: 400 },
      { action: "reload" },
    ] as const
  ) {
    const result = await act.execute("1", { ...params } as never, undefined);
    const text = result.content[0]!.type === "text"
      ? result.content[0]!.text
      : "";
    assertMatch(text, /ok/);
  }
  const kinds = okBackend.calls.map((c) =>
    (c.args[0] as { kind: string }).kind
  );
  assertEquals(kinds, [
    "click",
    "fill",
    "type",
    "press",
    "press",
    "select",
    "check",
    "uncheck",
    "scroll",
    "scroll",
    "reload",
  ]);

  // A page-level failure (unknown ref) must throw with the ref message.
  const failingBackend = new FakeBackend({
    act: { ok: false, code: "ref_not_found", error: "ref not found: e99" },
  });
  const failing = createBrowserTools(failingBackend).find(
    (t) => t.name === TOOL_BROWSER_ACT,
  )!;
  const error = await expectThrow(() =>
    failing.execute("2", { action: "click", ref: "e99" }, undefined)
  );
  assertMatch(error.message, /ref not found: e99/);
});

Deno.test("browser_act validates its arguments", async () => {
  const { byName } = toolMap();
  const act = byName.get(TOOL_BROWSER_ACT)!;
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ action: "click" }, /ref が必要/],
    [{ action: "fill", ref: "e1" }, /value が必要/],
    [{ action: "press", ref: "e1" }, /key が必要/],
    [{ action: "scroll" }, /ref か x\/y/],
    [{ action: "fly" }, /不明な action/],
  ];
  for (const [params, pattern] of cases) {
    const error = await expectThrow(() =>
      act.execute("1", params as never, undefined)
    );
    assertMatch(error.message, pattern);
  }
});

Deno.test("browser_wait passes options through and reports the result", async () => {
  const backend = new FakeBackend({
    wait: { ok: true, reason: "idle", durationMs: 320 },
  });
  const tools = createBrowserTools(backend);
  const wait = tools.find((t) => t.name === TOOL_BROWSER_WAIT)!;
  const result = await wait.execute(
    "1",
    { until: "idle", timeout_ms: 5000, idle_ms: 300 },
    undefined,
  );
  const args = backend.calls[0]!.args[0] as Record<string, unknown>;
  assertEquals(args.until, "idle");
  assertEquals(args.timeoutMs, 5000);
  assertEquals(args.idleMs, 300);
  const text = result.content[0]!.type === "text"
    ? result.content[0]!.text
    : "";
  assertMatch(text, /ネットワークがアイドル/);

  // Validation: url needs url_contains; time needs duration_ms; timeout range.
  for (
    const params of [
      { until: "url" },
      { until: "time" },
      { until: "load", timeout_ms: 0 },
    ]
  ) {
    const error = await expectThrow(() =>
      wait.execute("2", params as never, undefined)
    );
    assert(error instanceof Error, `must throw for ${JSON.stringify(params)}`);
  }
});

Deno.test("browser_screenshot returns the image as ToolResult content", async () => {
  const backend = new FakeBackend({
    screenshot: {
      mimeType: "image/png",
      data: "aGVsbG8=",
      width: 640,
      height: 480,
    },
  });
  const tools = createBrowserTools(backend);
  const shot = tools.find((t) => t.name === TOOL_BROWSER_SCREENSHOT)!;
  const result = await shot.execute("1", {}, undefined);
  assertEquals(result.content[1], {
    type: "image",
    data: "aGVsbG8=",
    mimeType: "image/png",
  });
  assertEquals(result.details?.width, 640);

  const bad = await expectThrow(() =>
    shot.execute("2", { format: "gif" }, undefined)
  );
  assertMatch(bad.message, /不明な format/);
});

Deno.test("browser_close is forwarded and backend.close is called", async () => {
  const { backend, byName } = toolMap();
  const close = byName.get(TOOL_BROWSER_CLOSE)!;
  await close.execute("1", {}, undefined);
  await close.execute("2", {}, undefined); // idempotent at the tool level too
  assertEquals(backend.closeCount, 2);
});

Deno.test("createCodingTools includes browser tools only with a backend", async () => {
  const root = await Deno.makeTempDir({ prefix: "lumisca-browser-tools-" });
  try {
    const workspace: Workspace = {
      id: "w1",
      name: "ws",
      folders: [root],
      createdAt: 0,
      chat: false,
    };
    const sandbox = new Sandbox([root]);
    const without = createCodingTools(workspace, {});
    assertEquals(
      without.some((t) => t.name === TOOL_BROWSER_OPEN),
      false,
      "no backend → no browser tools",
    );
    const backend = new FakeBackend({});
    const withBackend = createCodingTools(workspace, { browser: backend });
    assertEquals(
      withBackend.some((t) => t.name === TOOL_BROWSER_OPEN),
      true,
      "backend → browser tools present",
    );
    assertEquals(
      withBackend.filter((t) => t.name.startsWith("browser_")).length,
      6,
    );
    assert(sandbox instanceof Sandbox);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
