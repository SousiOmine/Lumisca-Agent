/**
 * HttpBrowserBackend: a BrowserBackend speaking the lumisca-browser RPC
 * protocol to a local host (the Desktop's in-shell Browser Lab IPC
 * endpoint, or the CLI's lumisca-browser-host process) over HTTP on
 * 127.0.0.1 with a per-run random token.
 *
 * No fallbacks live here: if the host is unreachable, unauthorised, or
 * returns an unexpected reply, the caller gets a BrowserBackendError —
 * never a silently substituted result.
 */
import {
  type ActionResult,
  type BrowserAction,
  type BrowserBackend,
  BrowserBackendError,
  type ImageResult,
  MAX_RPC_REQUEST_BYTES,
  MAX_RPC_RESPONSE_BYTES,
  type ObserveOptions,
  type OpenOptions,
  type PageInfo,
  type PageSnapshot,
  RPC_ACT,
  RPC_CLOSE,
  RPC_OBSERVE,
  RPC_OPEN,
  RPC_PATH,
  RPC_SCREENSHOT,
  RPC_TOKEN_HEADER,
  RPC_WAIT,
  type RpcFailure,
  type RpcRequest,
  type RpcResponse,
  type RpcSuccess,
  type ScreenshotOptions,
  TRANSPORT_ABORTED,
  TRANSPORT_BAD_REPLY,
  TRANSPORT_HTTP,
  TRANSPORT_REFUSED,
  type WaitOptions,
  type WaitResult,
} from "./types.ts";

export interface HttpBrowserBackendOptions {
  /** Base URL of the host's RPC endpoint, e.g.
   * "http://127.0.0.1:54321". Only loopback endpoints are accepted. */
  url: string;
  /** The per-run random token; sent with every request. */
  token: string;
  /** Per-request timeout in ms (default 30000; the wait tool's own
   * timeout is always shorter and governs waiting). */
  timeoutMs?: number;
}

function parseEndpoint(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new BrowserBackendError(
      TRANSPORT_BAD_REPLY,
      `browser RPC エンドポイントの URL が不正です: ${url}`,
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new BrowserBackendError(
      TRANSPORT_BAD_REPLY,
      `browser RPC エンドポイントは http(s) のみです: ${url}`,
    );
  }
  const host = parsed.hostname.toLowerCase();
  const bare = host.startsWith("[") && host.endsWith("]")
    ? host.slice(1, -1)
    : host;
  if (
    !["localhost", "127.0.0.1", "::1", "[::1]"].includes(host) &&
    !["localhost", "127.0.0.1", "::1", "[::1]"].includes(bare)
  ) {
    throw new BrowserBackendError(
      TRANSPORT_BAD_REPLY,
      `browser RPC エンドポイントはループバックのみ許可されます: ${url}`,
    );
  }
  return parsed;
}

/** Cap on the JSON-serialised snapshot returned to tools — observe is
 * bounded by the probe's own limits; this guards the wire twice. */
const MAX_PARSE_BYTES = MAX_RPC_RESPONSE_BYTES;

export class HttpBrowserBackend implements BrowserBackend {
  private readonly endpoint: URL;
  private readonly token: string;
  private readonly timeoutMs: number;
  private nextId = 1;

  constructor(options: HttpBrowserBackendOptions) {
    this.endpoint = parseEndpoint(options.url);
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  open(options: OpenOptions, signal?: AbortSignal): Promise<PageInfo> {
    return this.call<PageInfo>(
      RPC_OPEN,
      options as unknown as Record<string, unknown>,
      signal,
    );
  }

  observe(
    options?: ObserveOptions,
    signal?: AbortSignal,
  ): Promise<PageSnapshot> {
    return this.call<PageSnapshot>(
      RPC_OBSERVE,
      (options ?? {}) as Record<string, unknown>,
      signal,
    );
  }

  act(action: BrowserAction, signal?: AbortSignal): Promise<ActionResult> {
    return this.call<ActionResult>(
      RPC_ACT,
      action as Record<string, unknown>,
      signal,
    );
  }

  wait(options: WaitOptions, signal?: AbortSignal): Promise<WaitResult> {
    return this.call<WaitResult>(
      RPC_WAIT,
      options as unknown as Record<string, unknown>,
      signal,
    );
  }

  screenshot(
    options?: ScreenshotOptions,
    signal?: AbortSignal,
  ): Promise<ImageResult> {
    return this.call<ImageResult>(
      RPC_SCREENSHOT,
      (options ?? {}) as Record<string, unknown>,
      signal,
    );
  }

  async close(signal?: AbortSignal): Promise<void> {
    try {
      await this.call<Record<string, never>>(RPC_CLOSE, {}, signal);
    } catch (error) {
      // close is idempotent: a dead host counts as closed.
      if (
        error instanceof BrowserBackendError &&
        (error.code === TRANSPORT_REFUSED || error.code === "closed")
      ) {
        return;
      }
      throw error;
    }
  }

  /** One request/response round trip. Abort propagation: an aborted
   * signal settles the fetch; the host drops the request with its own
   * deadlines. Errors are mapped to BrowserBackendError with stable
   * codes (no retries, no fallbacks). */
  private async call<T>(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    const id = this.nextId++;
    const body: RpcRequest = { id, method, params };
    const payload = JSON.stringify(body);
    if (payload.length > MAX_RPC_REQUEST_BYTES) {
      throw new BrowserBackendError(
        "too_large",
        `browser RPC リクエストが大きすぎます (${payload.length} bytes)`,
      );
    }
    let response: Response;
    try {
      response = await fetch(new URL(RPC_PATH, this.endpoint), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [RPC_TOKEN_HEADER]: this.token,
        },
        body: payload,
        signal,
      });
    } catch (error) {
      if (signal?.aborted) {
        throw new BrowserBackendError(
          TRANSPORT_ABORTED,
          "browser 操作が中断されました",
        );
      }
      throw new BrowserBackendError(
        TRANSPORT_REFUSED,
        `browser host に接続できません (${describeFetchError(error)})`,
      );
    }
    if (response.status === 401) {
      throw new BrowserBackendError(
        "auth",
        "browser host がトークンを拒否しました (認証情報の不一致)",
      );
    }
    if (response.status === 413) {
      throw new BrowserBackendError(
        "too_large",
        "browser host がリクエストを大きすぎるとして拒否しました",
      );
    }
    if (!response.ok) {
      throw new BrowserBackendError(
        TRANSPORT_HTTP,
        `browser host が HTTP ${response.status} を返しました`,
      );
    }
    const text = await response.text();
    if (text.length > MAX_PARSE_BYTES) {
      throw new BrowserBackendError(
        "too_large",
        `browser host の応答が大きすぎます (${text.length} bytes)`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new BrowserBackendError(
        TRANSPORT_BAD_REPLY,
        "browser host の応答を JSON として解析できません",
      );
    }
    const rpc = parsed as RpcResponse;
    if (typeof rpc !== "object" || rpc === null || rpc.id !== id) {
      throw new BrowserBackendError(
        TRANSPORT_BAD_REPLY,
        "browser host の応答が不正です (id 不一致または形式不正)",
      );
    }
    if (rpc.ok === false) {
      const failure = rpc as RpcFailure;
      throw new BrowserBackendError(
        failure.error.code ?? "internal",
        failure.error.message ?? "browser host エラー",
      );
    }
    const result = (rpc as RpcSuccess).result;
    // Hosts encode page/probe-level failures (probe_missing,
    // ref_not_found, action_failed, ...) as `{ok:false, code|error, ...}`
    // result values — the eval channel cannot throw across the page
    // boundary. Normalize them here so every caller sees a thrown
    // BrowserBackendError with a stable code. Legitimate
    // non-failure results marked ok:false WITHOUT an error code (e.g. a
    // wait timeout: {ok:false, reason:"timeout"}) pass through untouched.
    if (typeof result === "object" && result !== null) {
      const failure = result as {
        ok?: unknown;
        code?: unknown;
        error?: { code?: unknown; message?: unknown };
      };
      if (
        failure.ok === false &&
        (failure.code !== undefined || failure.error?.code !== undefined)
      ) {
        throw new BrowserBackendError(
          String(failure.code ?? failure.error?.code ?? "action_failed"),
          String(failure.error?.message ?? "ページ操作に失敗しました"),
        );
      }
    }
    return result as T;
  }
}

function describeFetchError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
