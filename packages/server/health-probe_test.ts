/**
 * The one health probe.
 *
 * It replaced three hand-written requests with three different timeouts
 * (federation's identity check, the peer list's reachability check, the
 * systemd installer's startup poll). What is worth pinning is the answer
 * shape: "did not answer", "answered a failure" and "answered something
 * that is not a health body" are all the same answer — undefined — because
 * every caller treats them the same way, and none has a use for a throw.
 */
import { assert, assertEquals } from "@std/assert";
import { isSelf, probeHealth, TOKEN_HEADER } from "./health-probe.ts";

interface Served {
  status?: number;
  body?: unknown;
  /** What the request carried, recorded for the assertions. */
  headers?: Record<string, string>;
  /** Throw instead of answering (a refused connection). */
  throws?: boolean;
}

/** A server on a real port, so the probe exercises its own fetch. */
function serve(
  served: Served,
): { url: string; close: () => void; seen: { headers: Headers | null } } {
  const seen: { headers: Headers | null } = { headers: null };
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    (request) => {
      seen.headers = request.headers;
      if (served.throws === true) throw new Error("boom");
      return new Response(
        served.body === undefined ? null : JSON.stringify(served.body),
        {
          status: served.status ?? 200,
          headers: { "content-type": "application/json" },
        },
      );
    },
  );
  const { port } = server.addr;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => server.shutdown(),
    seen,
  };
}

const HEALTH = { ok: true, now: 1, instanceId: "abc" };

Deno.test("a live server answers with its health body", async () => {
  const served = serve({ body: HEALTH });
  try {
    const body = await probeHealth({ url: served.url, timeoutMs: 2_000 });
    assertEquals(body, HEALTH);
  } finally {
    served.close();
  }
});

Deno.test("the credential travels in the agreed header", async () => {
  const served = serve({ body: HEALTH });
  try {
    await probeHealth({
      url: served.url,
      token: "secret",
      timeoutMs: 2_000,
    });
    assertEquals(served.seen.headers?.get(TOKEN_HEADER), "secret");
  } finally {
    served.close();
  }
});

Deno.test("a trailing slash in the URL does not double the path", async () => {
  const served = serve({ body: HEALTH });
  try {
    // `${url}//api/health` would be a different route on a strict server.
    const body = await probeHealth({
      url: `${served.url}/`,
      timeoutMs: 2_000,
    });
    assertEquals(body?.instanceId, "abc");
  } finally {
    served.close();
  }
});

Deno.test("a failure status is no answer", async () => {
  const served = serve({ status: 401, body: { error: "no" } });
  try {
    assertEquals(
      await probeHealth({ url: served.url, timeoutMs: 2_000 }),
      undefined,
    );
  } finally {
    served.close();
  }
});

Deno.test("a body that is not a health shape is no answer", async () => {
  const served = serve({ body: { hello: "world" } });
  try {
    // A captive portal or a different service answering /api/health must not
    // be read as this server.
    assertEquals(
      await probeHealth({ url: served.url, timeoutMs: 2_000 }),
      undefined,
    );
  } finally {
    served.close();
  }
});

Deno.test("an unreachable server is no answer, not a throw", async () => {
  // Port 1 on loopback: nothing listens there.
  assertEquals(
    await probeHealth({ url: "http://127.0.0.1:1", timeoutMs: 500 }),
    undefined,
  );
});

Deno.test("isSelf compares the process id, not the address", async () => {
  const served = serve({ body: HEALTH });
  try {
    // The same server reached at two addresses answers with the same id, so
    // the id decides — never the URL.
    assert(await isSelf({ url: served.url, timeoutMs: 2_000, selfId: "abc" }));
    assertEquals(
      await isSelf({ url: served.url, timeoutMs: 2_000, selfId: "other" }),
      false,
    );
  } finally {
    served.close();
  }
});

Deno.test("an empty selfId never matches", async () => {
  // A core with no configured identity must not claim every peer as itself.
  const served = serve({ body: HEALTH });
  try {
    assertEquals(
      await isSelf({ url: served.url, timeoutMs: 2_000, selfId: "" }),
      false,
    );
  } finally {
    served.close();
  }
});
