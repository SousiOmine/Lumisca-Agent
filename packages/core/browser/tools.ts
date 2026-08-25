/**
 * The browser tool family: browser_open / browser_observe / browser_act /
 * browser_wait / browser_screenshot / browser_close. Identical schemas and
 * behavior for Desktop and CLI — both pass a BrowserBackend; the tools
 * never know which host backs it.
 *
 * The tools are never preloaded into the LLM context: the session pool
 * seeds them into the session's tool registry (discoverable via
 * tool_search), the same contract as MCP tools. Without a BrowserBackend
 * nothing is seeded at all — no stub, no default. The backend itself is
 * resolved at execute time through a provider, so a backend attached,
 * replaced or detached via setBrowserBackend after the tools were built
 * is always the one the tools talk to; a missing backend fails with a
 * clear error instead of a stale reference.
 */
import {
  boolean,
  integer,
  object,
  optional,
  string,
  type Tool,
  type ToolResult,
} from "../tools/schema.ts";
import {
  type BrowserAction,
  type BrowserBackend,
  type ElementInfo,
  MAX_ELEMENT_TEXT_CHARS,
  MAX_ELEMENT_VALUE_CHARS,
  type PageSnapshot,
  type WaitResult,
} from "./types.ts";
import { requireAllowedUrl } from "./policy.ts";
import { CoreError } from "../errors.ts";
import {
  TOOL_BROWSER_ACT,
  TOOL_BROWSER_CLOSE,
  TOOL_BROWSER_OBSERVE,
  TOOL_BROWSER_OPEN,
  TOOL_BROWSER_SCREENSHOT,
  TOOL_BROWSER_WAIT,
} from "../shared.ts";

/** Text cap for one observe result (the format below), applied before the
 * shared MAX_TOOL_OUTPUT truncation so the agent never sees a mid-element
 * cut. */
const OBSERVE_TEXT_CAP = 48 * 1024;

// --- formatting ------------------------------------------------------------

/** One element line, e.g. `button "保存" [ref=e12]` — the compact form the
 * LLM is taught to act on. */
function formatElement(el: ElementInfo): string {
  const flags: string[] = [];
  if (el.disabled) flags.push("disabled");
  if (!el.visible) flags.push("hidden");
  let line = `${el.role} "${el.name}" [ref=${el.ref}]`;
  if (el.headingLevel !== undefined) line += ` (h${el.headingLevel})`;
  if (el.href !== undefined) line += ` href=${el.href}`;
  const value = el.value ?? "";
  if (value !== "" && el.role !== "combobox") {
    line += ` value="${shorten(value, MAX_ELEMENT_VALUE_CHARS)}"`;
  }
  if (el.checked !== undefined) {
    line += el.checked ? " checked" : " unchecked";
  }
  if (el.text !== undefined && el.name !== el.text) {
    line += ` — "${shorten(el.text, MAX_ELEMENT_TEXT_CHARS)}"`;
  }
  if (el.focused) line += " focused";
  if (flags.length > 0) line += ` (${flags.join(", ")})`;
  return line;
}

function shorten(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** The observe result text: page header, elements, new console/errors,
 * network, digest text — bounded and LLM-shaped. */
export function formatSnapshot(snapshot: PageSnapshot): string {
  const lines: string[] = [];
  const state = snapshot.readyState === "complete"
    ? "complete"
    : snapshot.readyState === "interactive"
    ? "interactive"
    : "loading";
  lines.push(
    `Page: ${snapshot.title || "(untitled)"} — ${snapshot.url} ` +
      `(${state} · ${snapshot.viewport.width}×${snapshot.viewport.height})`,
  );
  if (snapshot.elements.length === 0) {
    lines.push("(操作可能な要素なし)");
  } else {
    for (const el of snapshot.elements) lines.push(formatElement(el));
  }
  const consoleNew = snapshot.console;
  if (consoleNew.length > 0) {
    lines.push("");
    lines.push(`Console (${consoleNew.length} since last observe):`);
    for (const entry of consoleNew.slice(0, 20)) {
      lines.push(`  ${entry.level}: ${entry.text}`);
    }
    if (consoleNew.length > 20) lines.push(`  … (+${consoleNew.length - 20})`);
  }
  if (snapshot.errors.length > 0) {
    lines.push("");
    lines.push(`Page errors (${snapshot.errors.length} since last observe):`);
    for (const err of snapshot.errors) {
      lines.push(`  ${err.kind}: ${err.message}`);
      if (err.detail) lines.push(`    ${err.detail}`);
    }
  }
  const net = snapshot.network;
  let idle = "idle";
  if (net.active > 0) idle = `${net.active} active`;
  else if (net.idleMs !== null && net.idleMs > 0) idle = `idle ${net.idleMs}ms`;
  const netParts = [
    `network: ${idle}`,
    `${net.completed} completed`,
  ];
  if (net.failed > 0) netParts.push(`${net.failed} failed`);
  lines.push(
    `${netParts.join(" · ")} · ${
      snapshot.mutated ? "DOM changed" : "DOM unchanged"
    }`,
  );
  if (snapshot.pageText.length > 0) {
    lines.push("");
    lines.push("[text]");
    lines.push(snapshot.pageText);
  }
  if (snapshot.truncated.length > 0) {
    lines.push(
      `(truncated: ${snapshot.truncated.join(", ")})`,
    );
  }
  const text = lines.join("\n");
  return text.length <= OBSERVE_TEXT_CAP
    ? text
    : text.slice(0, OBSERVE_TEXT_CAP);
}

// --- tools -----------------------------------------------------------------

const openSchema = object({
  url: string(
    "The URL to open. Only localhost / 127.0.0.1 / ::1 (http/https) are " +
      "allowed — a dev server or the app under development. Anything else " +
      "is rejected.",
  ),
  width: optional(
    integer(
      "Viewport width in CSS pixels (default 800). The page lays out " +
        "at this size and is scaled to fit the pane/window — specify e.g. " +
        "390×844 to debug a phone layout.",
    ),
  ),
  height: optional(
    integer("Viewport height in CSS pixels (default 600)"),
  ),
  visible: optional(boolean(
    "Whether the browser view is shown (default true). A hidden browser " +
      "still renders, but screenshots may be blank on some platforms.",
  )),
});

const observeSchema = object({
  include_text: optional(boolean(
    "Include the page-text digest (default true). Set false to keep " +
      "repeated observations light.",
  )),
});

const actSchema = object({
  action: string(
    'The action: "click" | "fill" (replace the value) | "type" (append to ' +
      'the value) | "press" (dispatch a key, e.g. Enter/Escape on the ' +
      'focused element or `ref`) | "select" (choose a <select> option) | ' +
      '"check" | "uncheck" | "scroll" (a ref, or x/y coordinates) | ' +
      '"reload"',
  ),
  ref: optional(string(
    "The element ref from browser_observe, e.g. e12. Required for every " +
      "action except scroll-by-coordinates and reload.",
  )),
  value: optional(string("Value for fill / type / select")),
  key: optional(string("Key name for press, e.g. Enter, Escape, Tab")),
  x: optional(integer("Horizontal scroll target (scroll without a ref)")),
  y: optional(integer("Vertical scroll target (scroll without a ref)")),
});

const waitSchema = object({
  until: string(
    '"load" (readyState complete) | "idle" (no active requests for ' +
      '"idle_ms"; WebSockets excluded) | "url" (URL contains "url_contains") | ' +
      '"time" (sleep "duration_ms")',
  ),
  timeout_ms: optional(integer("Upper bound in ms (default 10000)")),
  idle_ms: optional(integer("Quiet period for until=idle, ms (default 500)")),
  url_contains: optional(string("Substring for until=url")),
  duration_ms: optional(integer("Duration for until=time, ms")),
});

const screenshotSchema = object({
  format: optional(string('"png" (default) or "jpeg"')),
  quality: optional(integer(
    "JPEG quality 1-100 (default 80; ignored for png)",
  )),
});

const closeSchema = object({});

const DEFAULT_VIEWPORT_WIDTH = 800;
const DEFAULT_VIEWPORT_HEIGHT = 600;
/** The emulation range the hosts accept (CDP's own upper bound). */
const MAX_VIEWPORT_DIMENSION = 10_000;

/** The six tool names of the browser family. The session pool removes the
 * seeded tools with this list when the backend is detached. */
export const BROWSER_TOOL_NAMES: readonly string[] = [
  TOOL_BROWSER_OPEN,
  TOOL_BROWSER_OBSERVE,
  TOOL_BROWSER_ACT,
  TOOL_BROWSER_WAIT,
  TOOL_BROWSER_SCREENSHOT,
  TOOL_BROWSER_CLOSE,
];

/** Resolve the backend a browser tool executes against, failing with a
 * clear error when the backend is gone (setBrowserBackend detached it
 * after the tools were seeded). */
function requireBackend(
  resolveBackend: () => BrowserBackend | undefined,
): BrowserBackend {
  const backend = resolveBackend();
  if (backend === undefined) {
    throw new CoreError(
      "ブラウザバックエンドが利用できません (browser tools are not " +
        "attached to this session)",
      "unavailable",
    );
  }
  return backend;
}

/** Build the six browser tools over a fixed backend. */
export function createBrowserTools(backend: BrowserBackend): Tool[] {
  return createBrowserToolsFrom(() => backend);
}

/** Build the six browser tools over a backend resolver. The resolver runs
 * at execute time, so setBrowserBackend calls after the tools were built
 * (replacement or detach) are honored without rebuilding them; a
 * resolution of undefined fails the call with a clear error. The session
 * pool seeds the registry this way, keeping the seeded tools live. */
export function createBrowserToolsFrom(
  resolveBackend: () => BrowserBackend | undefined,
): Tool[] {
  return [
    createBrowserOpenTool(resolveBackend),
    createBrowserObserveTool(resolveBackend),
    createBrowserActTool(resolveBackend),
    createBrowserWaitTool(resolveBackend),
    createBrowserScreenshotTool(resolveBackend),
    createBrowserCloseTool(resolveBackend),
  ];
}

function createBrowserOpenTool(
  resolveBackend: () => BrowserBackend | undefined,
): Tool<typeof openSchema> {
  return {
    name: TOOL_BROWSER_OPEN,
    label: "Browser Open",
    description:
      "Open a local web app in the built-in browser (an OS-standard " +
      "WebView inside Lumisca — never an external browser). Only " +
      "localhost / 127.0.0.1 / ::1 URLs are allowed. Use browser_observe " +
      "to see the page, browser_act to interact, browser_screenshot to " +
      "capture it. Opening again navigates the same browser. The viewport " +
      "defaults to 800×600 and is scaled to fit the pane/window; pass " +
      "width/height (CSS pixels) to debug other layouts — e.g. 390×844 " +
      "for a phone — and browser_observe reports the active viewport. If " +
      "the operation fails, the tools report it — there is no fallback.",
    parameters: openSchema,
    execute: async (_id, params, signal): Promise<ToolResult> => {
      const allowed = requireAllowedUrl(params.url); // throws with the policy reason
      const width = params.width ?? DEFAULT_VIEWPORT_WIDTH;
      const height = params.height ?? DEFAULT_VIEWPORT_HEIGHT;
      if (
        width < 1 || width > MAX_VIEWPORT_DIMENSION ||
        height < 1 || height > MAX_VIEWPORT_DIMENSION
      ) {
        throw new CoreError(
          `width/height は 1〜${MAX_VIEWPORT_DIMENSION} の範囲です ` +
            `(width=${width}, height=${height})`,
          "invalid",
        );
      }
      const info = await requireBackend(resolveBackend).open(
        {
          url: allowed.url,
          width,
          height,
          ...(params.visible !== undefined ? { visible: params.visible } : {}),
        },
        signal,
      );
      return {
        content: [{
          type: "text",
          text:
            `Opened ${info.url} in the browser (viewport ${width}×${height}).` +
            (info.title ? ` Title: "${info.title}"` : "") +
            ` Use browser_observe to inspect it.`,
        }],
        details: { ...info },
      };
    },
  };
}

function createBrowserObserveTool(
  resolveBackend: () => BrowserBackend | undefined,
): Tool<typeof observeSchema> {
  return {
    name: TOOL_BROWSER_OBSERVE,
    label: "Browser Observe",
    description:
      "Take a semantic snapshot of the page in the browser: headings, " +
      "buttons, links, form controls (with roles, accessible names, " +
      "disabled/visible state) and element refs for browser_act, plus " +
      "console entries and page errors collected since the previous " +
      "observe, network activity and a digest of the visible text. " +
      "Elements are listed in document order; never raw HTML.",
    parameters: observeSchema,
    execute: async (_id, params, signal): Promise<ToolResult> => {
      const snapshot = await requireBackend(resolveBackend).observe(
        { includeText: params.include_text ?? true },
        signal,
      );
      const text = formatSnapshot(snapshot);
      return {
        content: [{ type: "text", text }],
        details: {
          url: snapshot.url,
          title: snapshot.title,
          readyState: snapshot.readyState,
          elementCount: snapshot.elements.length,
          consoleCount: snapshot.console.length,
          errorCount: snapshot.errors.length,
          network: snapshot.network,
        },
      };
    },
  };
}

/** Turn a PageActionResult failure into a thrown error (tools throw on
 * failure — see schema.ts). */
function actResultOrThrow(
  result: { ok: boolean; code?: string; error?: string },
): void {
  if (result.ok) return;
  throw new CoreError(
    `browser_act 失敗 (${result.code ?? "action_failed"}): ${
      result.error ?? "不明な理由"
    }`,
    "unavailable",
  );
}

function createBrowserActTool(
  resolveBackend: () => BrowserBackend | undefined,
): Tool<typeof actSchema> {
  return {
    name: TOOL_BROWSER_ACT,
    label: "Browser Act",
    description:
      "Interact with the page in the browser: click / fill / type / " +
      "press / select / check / uncheck / scroll a ref from " +
      "browser_observe, or reload the page. fill replaces the value, type " +
      "appends; both dispatch input+change so React-style apps see the " +
      "change. press dispatches keydown/keyup (synthetic keys do not " +
      "trigger default actions, except Enter submitting the form). " +
      "Returns the target element's updated info.",
    parameters: actSchema,
    execute: async (_id, params, signal): Promise<ToolResult> => {
      const action = buildAction(params);
      const result = await requireBackend(resolveBackend).act(action, signal);
      actResultOrThrow(result);
      const lines = [`${params.action} ok`];
      if (result.url !== undefined) lines.push(`url: ${result.url}`);
      if (result.element !== undefined) {
        lines.push(formatElement(result.element));
      }
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { action: params.action, ...result },
      };
    },
  };
}

function buildAction(params: {
  action: string;
  ref?: string;
  value?: string;
  key?: string;
  x?: number;
  y?: number;
}): BrowserAction {
  const ref = params.ref;
  switch (params.action) {
    case "click":
      requireRef(params, ref);
      return { kind: "click", ref: ref! };
    case "fill":
      requireRef(params, ref);
      requireValue(params, params.value);
      return { kind: "fill", ref: ref!, value: params.value! };
    case "type":
      requireRef(params, ref);
      requireValue(params, params.value);
      return { kind: "type", ref: ref!, value: params.value! };
    case "press":
      if (params.key === undefined) {
        throw new CoreError("press には key が必要です (例: Enter)", "invalid");
      }
      return ref === undefined ? { kind: "press", key: params.key } : {
        kind: "press",
        ref,
        key: params.key,
      };
    case "select":
      requireRef(params, ref);
      requireValue(params, params.value);
      return { kind: "select", ref: ref!, value: params.value! };
    case "check":
      requireRef(params, ref);
      return { kind: "check", ref: ref! };
    case "uncheck":
      requireRef(params, ref);
      return { kind: "uncheck", ref: ref! };
    case "scroll":
      if (ref !== undefined) return { kind: "scroll", ref };
      if (params.x !== undefined || params.y !== undefined) {
        return { kind: "scroll", x: params.x ?? 0, y: params.y ?? 0 };
      }
      throw new CoreError("scroll には ref か x/y が必要です", "invalid");
    case "reload":
      return { kind: "reload" };
    default:
      throw new CoreError(`不明な action: ${params.action}`, "invalid");
  }
}

function requireRef(
  params: { action: string },
  ref: string | undefined,
): asserts ref is string {
  if (ref === undefined) {
    throw new CoreError(
      `${params.action} には browser_observe の ref が必要です`,
      "invalid",
    );
  }
}

function requireValue(
  params: { action: string },
  value: string | undefined,
): asserts value is string {
  if (value === undefined) {
    throw new CoreError(
      `${params.action} には value が必要です`,
      "invalid",
    );
  }
}

function createBrowserWaitTool(
  resolveBackend: () => BrowserBackend | undefined,
): Tool<typeof waitSchema> {
  return {
    name: TOOL_BROWSER_WAIT,
    label: "Browser Wait",
    description: "Wait for the page in the browser: until=load (readyState " +
      "complete), idle (no active fetch/XHR for idle_ms — WebSockets like " +
      "dev-server hot reload do not count), url (URL contains " +
      "url_contains), or time. Event-driven in the page; returns when the " +
      "condition holds or the timeout elapses (ok=false, never throws).",
    parameters: waitSchema,
    execute: async (_id, params, signal): Promise<ToolResult> => {
      const wait = buildWait(params);
      const result = await requireBackend(resolveBackend).wait(wait, signal);
      return {
        content: [{ type: "text", text: formatWaitResult(result) }],
        details: { ...result },
      };
    },
  };
}

function buildWait(params: {
  until: string;
  timeout_ms?: number;
  idle_ms?: number;
  url_contains?: string;
  duration_ms?: number;
}) {
  const timeoutMs = params.timeout_ms;
  if (timeoutMs !== undefined && (timeoutMs < 1 || timeoutMs > 300_000)) {
    throw new CoreError(
      `timeout_ms は 1〜300000 の範囲です (got ${timeoutMs})`,
      "invalid",
    );
  }
  switch (params.until) {
    case "load":
      return {
        until: "load" as const,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      };
    case "idle":
      return {
        until: "idle" as const,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(params.idle_ms !== undefined ? { idleMs: params.idle_ms } : {}),
      };
    case "url":
      if (params.url_contains === undefined || params.url_contains === "") {
        throw new CoreError(
          "until=url には url_contains が必要です",
          "invalid",
        );
      }
      return {
        until: "url" as const,
        urlContains: params.url_contains,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      };
    case "time":
      if (params.duration_ms === undefined || params.duration_ms < 0) {
        throw new CoreError(
          "until=time には duration_ms (0以上) が必要です",
          "invalid",
        );
      }
      return {
        until: "time" as const,
        durationMs: params.duration_ms,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      };
    default:
      throw new CoreError(
        `不明な until: ${params.until} (load / idle / url / time)`,
        "invalid",
      );
  }
}

function formatWaitResult(result: WaitResult): string {
  const state = result.ok
    ? result.reason === "loaded"
      ? "ページが読み込まれました"
      : result.reason === "idle"
      ? "ネットワークがアイドルになりました"
      : result.reason === "url"
      ? `URL が一致しました: ${result.detail ?? ""}`
      : "待機時間が経過しました"
    : `タイムアウト (${result.durationMs}ms)`;
  return `${state} (${result.durationMs}ms)`;
}

function createBrowserScreenshotTool(
  resolveBackend: () => BrowserBackend | undefined,
): Tool<typeof screenshotSchema> {
  return {
    name: TOOL_BROWSER_SCREENSHOT,
    label: "Browser Screenshot",
    description:
      "Capture the browser view as an image (PNG or JPEG) and return it " +
      "as an image result. On Windows this uses the WebView2 " +
      "DevTools protocol directly; on macOS/Linux the host reports an " +
      "explicit error where capture is not implemented — never a blank " +
      "or substituted image.",
    parameters: screenshotSchema,
    execute: async (_id, params, signal): Promise<ToolResult> => {
      const format = params.format ?? "png";
      if (format !== "png" && format !== "jpeg") {
        throw new CoreError(`不明な format: ${format} (png / jpeg)`, "invalid");
      }
      const quality = params.quality;
      if (quality !== undefined && (quality < 1 || quality > 100)) {
        throw new CoreError("quality は 1〜100 の範囲です", "invalid");
      }
      const image = await requireBackend(resolveBackend).screenshot(
        { format, ...(quality !== undefined ? { quality } : {}) },
        signal,
      );
      const size = image.width !== undefined && image.height !== undefined
        ? ` (${image.width}×${image.height})`
        : "";
      return {
        content: [
          {
            type: "text",
            text: `Screenshot${size} (${image.mimeType}).`,
          },
          { type: "image", data: image.data, mimeType: image.mimeType },
        ],
        details: {
          mimeType: image.mimeType,
          width: image.width,
          height: image.height,
          bytes: image.data.length,
        },
      };
    },
  };
}

function createBrowserCloseTool(
  resolveBackend: () => BrowserBackend | undefined,
): Tool<typeof closeSchema> {
  return {
    name: TOOL_BROWSER_CLOSE,
    label: "Browser Close",
    description:
      "Close the browser: destroy the debug WebView (Desktop) or stop " +
      "the browser host process (CLI), releasing every subscription and " +
      "the view. Idempotent — closing an already-closed browser is a " +
      "no-op. browser_open starts a fresh one afterwards.",
    parameters: closeSchema,
    execute: async (_id, _params, signal): Promise<ToolResult> => {
      await requireBackend(resolveBackend).close(signal);
      return {
        content: [{
          type: "text",
          text: "Browser closed. browser_open でもう一度開けます。",
        }],
        details: { closed: true },
      };
    },
  };
}
