import { assertEquals } from "@std/assert";

/**
 * The fetch recorder both client tests share (api-local_test,
 * api-routing_test).
 *
 * Both suites pin the request the client builds — method, path, body, token
 * header — because that request IS the contract with the server's routes. The
 * recorder was copy-pasted, so a fix to one copy (the token header, the
 * single-request assertion) could leave the other test blind to the very
 * regression it was written for.
 *
 * `BASE` is the origin the client's relative API paths resolve against; the
 * page and the API share one origin, so any base works as long as the
 * recorded path is taken from the resolved URL.
 */
export const BASE = "http://127.0.0.1:8000";

/** One request the client made, as these tests care about it. `path` keeps
 * the query string, which several calls build client-side. */
export interface SentRequest {
  method: string;
  path: string;
  body: string | undefined;
  headers: Headers;
}

/** What the stubbed fetch answers. */
export type Responder = () => Response | Promise<Response>;

/** The 200-with-an-empty-JSON-object answer every caller parses, so an
 * assertion is about the request and not the response. */
export const ok: Responder = () =>
  new Response("{}", {
    status: 200,
    headers: { "content-type": "application/json" },
  });

/** A JSON error answer, shaped like the server's (`{ error }` + status). */
export function jsonError(status: number, error: string): Responder {
  return () =>
    new Response(JSON.stringify({ error }), {
      status,
      headers: { "content-type": "application/json" },
    });
}

/** Run `call` with `fetch` replaced by a recorder and report the single
 * request it sent plus the failure, if any. The stub is restored in a
 * `finally`, so a failing assertion cannot leak it into another test or file
 * (the suite runs with --parallel). */
export async function intercept(
  call: () => Promise<unknown>,
  respond: Responder = ok,
): Promise<{ request: SentRequest; error?: Error }> {
  const original = globalThis.fetch;
  const sent: SentRequest[] = [];
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
    const target = input instanceof Request ? input.url : String(input);
    const url = new URL(target, BASE);
    sent.push({
      method: init?.method ?? "GET",
      path: `${url.pathname}${url.search}`,
      body: typeof init?.body === "string" ? init.body : undefined,
      headers: new Headers(init?.headers),
    });
    return Promise.resolve(respond());
  };
  let error: Error | undefined;
  try {
    await call();
  } catch (cause) {
    error = cause instanceof Error ? cause : new Error(String(cause));
  } finally {
    globalThis.fetch = original;
  }
  // One call, one request: a fallback (local after a failed peer, or a
  // retried call) would show up here.
  assertEquals(sent.length, 1, "the call must reach the network exactly once");
  return { request: sent[0]!, error };
}

/** The request of a call that must succeed. */
export async function record(
  call: () => Promise<unknown>,
  respond: Responder = ok,
): Promise<SentRequest> {
  const { request, error } = await intercept(call, respond);
  assertEquals(error, undefined, `the call must not fail: ${error?.message}`);
  return request;
}

/** Pin one request: its HTTP method, its path (pathname + query) and its
 * body (undefined = no body at all). */
export function assertRequest(
  sent: SentRequest,
  method: string,
  path: string,
  body: string | undefined = undefined,
): void {
  assertEquals(sent.method, method, `the method of ${path}`);
  assertEquals(sent.path, path, `the URL of ${path}`);
  assertEquals(sent.body, body, `the body of ${path}`);
}
