import { assert, assertEquals, assertMatch } from "@std/assert";
import { HttpBrowserBackend } from "./client.ts";
import {
  BrowserBackendError,
  RPC_TOKEN_HEADER,
  TRANSPORT_BAD_REPLY,
  TRANSPORT_HTTP,
  TRANSPORT_REFUSED,
} from "./types.ts";

/** Run fn and assert it throws a BrowserBackendError with the given code. */
async function expectCode(
  fn: () => Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await fn();
  } catch (error) {
    assert(
      error instanceof BrowserBackendError,
      `expected BrowserBackendError, got: ${String(error)}`,
    );
    assertEquals(error.code, code);
    return;
  }
  throw new Error(`expected BrowserBackendError with code ${code}`);
}

/** A minimal mock of the host side: records requests, replies per a
 * script queue. Serves the RPC protocol on 127.0.0.1. */
class MockHost {
  private readonly seen: Array<
    { method: string; params: unknown; token: string | null }
  > = [];
  private replies: Array<
    | { status: number; body: string }
    | ((req: { method: string; params: unknown; token: string | null }) =>
      | { status: number; body: string }
      | Promise<{ status: number; body: string }>)
  > = [];
  private server: Deno.HttpServer | null = null;
  url = "";

  start(_token: string): void {
    const controller = new AbortController();
    this.server = Deno.serve(
      {
        hostname: "127.0.0.1",
        port: 0,
        onListen: () => {},
        signal: controller.signal,
      },
      (request) => this.handle(request),
    );
    const addr = this.server.addr as Deno.NetAddr;
    this.url = `http://127.0.0.1:${addr.port}`;
  }

  private async handle(request: Request): Promise<Response> {
    const record = {
      method: "",
      params: null as unknown,
      token: request.headers.get(RPC_TOKEN_HEADER),
    };
    try {
      const body = await request.json() as { method: string; params: unknown };
      record.method = body.method;
      record.params = body.params;
    } catch {
      // keep method empty
    }
    this.seen.push(record);
    const reply = this.replies.shift();
    if (reply === undefined) {
      return new Response(
        JSON.stringify({
          ok: false,
          id: 0,
          error: { code: "internal", message: "no reply queued" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    const resolved = typeof reply === "function" ? await reply(record) : reply;
    return new Response(resolved.body, {
      status: resolved.status,
      headers: { "content-type": "application/json" },
    });
  }

  queue(status: number, body: string): void {
    this.replies.push({ status, body });
  }

  queueFn(
    fn: (req: { method: string; params: unknown; token: string | null }) =>
      | { status: number; body: string }
      | Promise<{ status: number; body: string }>,
  ): void {
    this.replies.push(fn);
  }

  get requests() {
    return this.seen;
  }

  async stop(): Promise<void> {
    await this.server?.shutdown();
  }
}

function rpcSuccess(id: number, result: unknown): string {
  return JSON.stringify({ id, ok: true, result });
}

function rpcFailure(id: number, code: string, message: string): string {
  return JSON.stringify({ id, ok: false, error: { code, message } });
}

Deno.test("HttpBrowserBackend round-trips open/observe with the token", async () => {
  const host = new MockHost();
  await host.start("tok123");
  try {
    host.queue(
      200,
      rpcSuccess(1, { url: "http://127.0.0.1:5173/", title: "App" }),
    );
    host.queue(
      200,
      rpcSuccess(2, { url: "http://127.0.0.1:5173/", readyState: "complete" }),
    );
    const backend = new HttpBrowserBackend({ url: host.url, token: "tok123" });

    const info = await backend.open({ url: "http://127.0.0.1:5173/" });
    assertEquals(info.title, "App");
    assertEquals(info.url, "http://127.0.0.1:5173/");

    await backend.observe();
    assertEquals(host.requests.length, 2);
    assertEquals(host.requests[0]!.method, "open");
    assertEquals(host.requests[1]!.method, "observe");
    for (const req of host.requests) {
      assertEquals(req.token, "tok123", "every request must carry the token");
    }
  } finally {
    await host.stop();
  }
});

Deno.test("RPC failures map to BrowserBackendError with the host's code", async () => {
  const host = new MockHost();
  await host.start("t");
  try {
    host.queue(200, rpcFailure(1, "ref_not_found", "ref not found: e5"));
    const backend = new HttpBrowserBackend({ url: host.url, token: "t" });
    const error = await (async () => {
      try {
        await backend.act({ kind: "click", ref: "e5" });
      } catch (e) {
        return e;
      }
      throw new Error("expected act to throw");
    })();
    assert(error instanceof BrowserBackendError);
    assertEquals(error.code, "ref_not_found");
    assertMatch(error.message, /ref not found: e5/);
  } finally {
    await host.stop();
  }
});

Deno.test("auth failures and HTTP errors surface distinctly", async () => {
  const host = new MockHost();
  await host.start("t");
  try {
    host.queue(401, "{}");
    const backend = new HttpBrowserBackend({ url: host.url, token: "wrong" });
    await expectCode(
      () => backend.open({ url: "http://127.0.0.1:1/" }),
      "auth",
    );

    host.queue(500, "boom");
    await expectCode(
      () => backend.open({ url: "http://127.0.0.1:1/" }),
      TRANSPORT_HTTP,
    );
  } finally {
    await host.stop();
  }
});

Deno.test("malformed replies are explicit errors, not silent values", async () => {
  const host = new MockHost();
  await host.start("t");
  try {
    host.queue(200, "not json");
    const backend = new HttpBrowserBackend({ url: host.url, token: "t" });
    await expectCode(() => backend.observe(), TRANSPORT_BAD_REPLY);

    // id mismatch
    host.queue(200, rpcSuccess(999, {}));
    await expectCode(() => backend.observe(), TRANSPORT_BAD_REPLY);
  } finally {
    await host.stop();
  }
});

Deno.test("connect-refused hosts produce transport_refused", async () => {
  // Bind a listener and close it, so the port is known-dead.
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  const backend = new HttpBrowserBackend({
    url: `http://127.0.0.1:${port}`,
    token: "t",
    timeoutMs: 2000,
  });
  await expectCode(() => backend.observe(), TRANSPORT_REFUSED);
});

Deno.test("abort settles the call with transport_aborted", async () => {
  const host = new MockHost();
  await host.start("t");
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  try {
    // The host accepts the request and then never replies; the fetch stays
    // open until the abort. The gate lets the test release the handler
    // afterwards so server.shutdown() can finish.
    host.queueFn(async () => {
      await gate;
      return { status: 200, body: "{}" };
    });
    const backend = new HttpBrowserBackend({
      url: host.url,
      token: "t",
      timeoutMs: 30_000,
    });
    const controller = new AbortController();
    const call = backend.wait(
      { until: "time", durationMs: 10 },
      controller.signal,
    );
    setTimeout(() => controller.abort(), 50);
    await expectCode(() => call, "transport_aborted");
  } finally {
    release();
    await host.stop();
  }
});

Deno.test("oversized replies are refused with too_large", async () => {
  const host = new MockHost();
  await host.start("t");
  try {
    const big = "x".repeat(2 * 1024 * 1024);
    host.queue(200, rpcSuccess(1, { pageText: big }));
    const backend = new HttpBrowserBackend({ url: host.url, token: "t" });
    await expectCode(() => backend.observe(), "too_large");
  } finally {
    await host.stop();
  }
});

Deno.test("close treats a dead host as already closed (idempotent)", async () => {
  const host = new MockHost();
  await host.start("t");
  const url = host.url;
  await host.stop();
  const backend = new HttpBrowserBackend({ url, token: "t", timeoutMs: 1000 });
  await backend.close(); // must not throw
});

Deno.test("the endpoint must be loopback (security)", () => {
  let message = "";
  try {
    new HttpBrowserBackend({ url: "http://10.0.0.1:9000", token: "t" });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assertMatch(message, /ループバック/);
  try {
    new HttpBrowserBackend({ url: "http://example.com:9000", token: "t" });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assertMatch(message, /ループバック/);
  // HTTPS loopback is accepted (defense in depth: a local TLS endpoint).
  const httpsBackend = new HttpBrowserBackend({
    url: "https://127.0.0.1:9000",
    token: "t",
  });
  assert(httpsBackend instanceof HttpBrowserBackend);
});

Deno.test("screenshot results pass through as data", async () => {
  const host = new MockHost();
  await host.start("t");
  try {
    host.queue(
      200,
      rpcSuccess(1, {
        mimeType: "image/png",
        data: "AAEC",
        width: 100,
        height: 50,
      }),
    );
    const backend = new HttpBrowserBackend({ url: host.url, token: "t" });
    const image = await backend.screenshot({ format: "png" });
    assertEquals(image.mimeType, "image/png");
    assertEquals(image.data, "AAEC");
    assertEquals(image.width, 100);
  } finally {
    await host.stop();
  }
});
