import { fauxProvider, LumiscaCore } from "@lumisca/core";
import { LANGUAGE_KEY } from "@lumisca/core/shared";
import { assert, assertEquals } from "@std/assert";
import { createApp } from "./app.ts";
import { validateHostConfig } from "./security.ts";
import { setup } from "./test-utils.ts";

Deno.test("server rejects non-loopback Host headers (DNS rebinding guard)", async () => {
  // Deno's fetch forbids overriding Host, so exercise the handler directly
  // with requests that target external hostnames.
  const faux = fauxProvider();
  const core = LumiscaCore.forTesting([faux.provider]);
  const app = createApp(core);
  try {
    const evil = await app.fetch(
      new Request("http://evil.example.com/api/health"),
    );
    assertEquals(evil.status, 403);
    const loopback = await app.fetch(
      new Request("http://127.0.0.1:8000/api/health", {
        headers: { host: "127.0.0.1:8000" },
      }),
    );
    assertEquals(loopback.status, 200);
  } finally {
    core.close();
  }
});

Deno.test("cors only allows same-origin and the tauri webview origin", async () => {
  const { core, server, base } = await setup();
  try {
    const evil = await fetch(`${base}/api/health`, {
      headers: { Origin: "https://evil.example.com" },
    });
    assertEquals(
      evil.headers.get("access-control-allow-origin"),
      null,
      "cross-origin reads must be blocked",
    );

    const tauri = await fetch(`${base}/api/health`, {
      headers: { Origin: "tauri://localhost" },
    });
    assertEquals(
      tauri.headers.get("access-control-allow-origin"),
      "tauri://localhost",
    );

    const same = await fetch(`${base}/api/health`, {
      headers: { Origin: base },
    });
    assertEquals(same.headers.get("access-control-allow-origin"), base);
  } finally {
    server.shutdown();
    core.close();
  }
});

Deno.test("websocket rejects cross-port origins", async () => {
  const faux = fauxProvider();
  const core = LumiscaCore.forTesting([faux.provider]);
  const app = createApp(core);
  try {
    const crossPort = await app.fetch(
      new Request("http://127.0.0.1:8000/ws", {
        headers: { origin: "http://127.0.0.1:3000" },
      }),
    );
    assertEquals(crossPort.status, 403, "cross-port WS must be rejected");
  } finally {
    core.close();
  }
});

Deno.test("token auth guards the API, websocket and page", async () => {
  const faux = fauxProvider();
  const core = LumiscaCore.forTesting([faux.provider]);
  const app = createApp(core, { token: "secret-token" });
  // `new Request(...)` does not add a Host header; the loopback Host guard
  // needs one, so every probe sets it explicitly.
  const HOST = { host: "127.0.0.1:8000" };
  try {
    // Without the token: 401.
    const denied = await app.fetch(
      new Request("http://127.0.0.1:8000/api/health", { headers: HOST }),
    );
    assertEquals(denied.status, 401);

    // Wrong token: 401.
    const wrong = await app.fetch(
      new Request("http://127.0.0.1:8000/api/health", {
        headers: { ...HOST, "x-lumisca-token": "nope" },
      }),
    );
    assertEquals(wrong.status, 401);

    // Correct header: allowed.
    const ok = await app.fetch(
      new Request("http://127.0.0.1:8000/api/health", {
        headers: { ...HOST, "x-lumisca-token": "secret-token" },
      }),
    );
    assertEquals(ok.status, 200);

    // WS: query parameter token (browsers cannot set WS headers).
    const wsDenied = await app.fetch(
      new Request("http://127.0.0.1:8000/ws", { headers: HOST }),
    );
    assertEquals(wsDenied.status, 401);
    // With the token the guard passes; the upgrade itself does not complete
    // without websocket headers, so assert only that it is not the guard's
    // 401/403.
    const wsOk = await app.fetch(
      new Request("http://127.0.0.1:8000/ws?token=secret-token", {
        headers: HOST,
      }),
    );
    assertEquals(wsOk.status !== 401 && wsOk.status !== 403, true);

    // The conversation's own stream is under /api, so the same guard covers
    // it (a token-less handshake never reaches the upgrade).
    const stellaDenied = await app.fetch(
      new Request("http://127.0.0.1:8000/api/stella/conversations/a/events", {
        headers: HOST,
      }),
    );
    assertEquals(stellaDenied.status, 401);
    const stellaOk = await app.fetch(
      new Request(
        "http://127.0.0.1:8000/api/stella/conversations/a/events?token=secret-token",
        { headers: HOST },
      ),
    );
    assertEquals(stellaOk.status !== 401 && stellaOk.status !== 403, true);

    // The page itself is guarded too (the token is a real capability).
    const pageDenied = await app.fetch(
      new Request("http://127.0.0.1:8000/", { headers: HOST }),
    );
    assertEquals(pageDenied.status, 401);

    // With `?token=` the page renders; the externalized initial-data script
    // (inline scripts are banned by the page CSP) carries the token in its
    // URL so the guarded asset can be fetched.
    const page = await app.fetch(
      new Request("http://127.0.0.1:8000/?token=secret-token", {
        headers: HOST,
      }),
    );
    const html = await page.text();
    assertEquals(
      html.includes('src="/assets/initial-data.js?token=secret-token"'),
      true,
    );

    const dataDenied = await app.fetch(
      new Request("http://127.0.0.1:8000/assets/initial-data.js", {
        headers: HOST,
      }),
    );
    assertEquals(dataDenied.status, 401);

    const dataScript = await app.fetch(
      new Request(
        "http://127.0.0.1:8000/assets/initial-data.js?token=secret-token",
        { headers: HOST },
      ),
    );
    const script = await dataScript.text();
    assertEquals(
      script.includes('window.__LUMISCA_TOKEN__ = "secret-token"'),
      true,
    );

    // The PWA surface is on the token-free list: a browser's install
    // pipeline asks for it without this server's cookie, and a 401 there
    // makes the app uninstallable rather than protected.
    for (const path of [
      "/manifest.webmanifest",
      "/sw.js",
      "/pwa/icon-192.png",
    ]) {
      const response = await app.fetch(
        new Request(`http://127.0.0.1:8000${path}`, { headers: HOST }),
      );
      assertEquals(response.status, 200, path);
    }
  } finally {
    core.close();
  }
});

Deno.test("token auth remembers a presented token in a cookie", async () => {
  const faux = fauxProvider();
  const core = LumiscaCore.forTesting([faux.provider]);
  const app = createApp(core, { token: "secret-token" });
  const HOST = { host: "127.0.0.1:8000" };
  try {
    // The first visit carries the token in the URL (that is what the
    // desktop shell and `service install` hand out). The answer stores it in
    // a cookie — the point of this test — and keeps passing the token down
    // to the page, which the desktop shell's bridge key depends on.
    const first = await app.fetch(
      new Request("http://127.0.0.1:8000/?token=secret-token", {
        headers: HOST,
      }),
    );
    assertEquals(first.status, 200);
    const setCookie = first.headers.get("set-cookie") ?? "";
    assertEquals(
      setCookie.startsWith("lumisca_token_8000=secret-token"),
      true,
      setCookie,
    );
    assertEquals(setCookie.includes("HttpOnly"), true);
    assertEquals(setCookie.includes("SameSite=Lax"), true);
    assertEquals(
      (await first.text()).includes(
        'src="/assets/initial-data.js?token=secret-token"',
      ),
      true,
    );

    // From then on the browser sends only the cookie: the address bar has no
    // token, yet the app comes up — the guard, the API and the WebSocket all
    // accept the remembered credential.
    const remembered = { ...HOST, cookie: "lumisca_token_8000=secret-token" };
    const page = await app.fetch(
      new Request("http://127.0.0.1:8000/", { headers: remembered }),
    );
    assertEquals(page.status, 200);
    // Nothing to tell the browser again — the cookie is already there.
    assertEquals(page.headers.get("set-cookie"), null);
    // The page keeps carrying the token: the desktop shell's bridge key and
    // the UI's request header are built from it, and a reload without
    // `?token=` (the client strips it after the first load) must not lose
    // them.
    assertEquals(
      (await page.text()).includes(
        'src="/assets/initial-data.js?token=secret-token"',
      ),
      true,
    );

    const data = await app.fetch(
      new Request("http://127.0.0.1:8000/assets/initial-data.js", {
        headers: remembered,
      }),
    );
    assertEquals(data.status, 200);
    assertEquals(
      (await data.text()).includes('window.__LUMISCA_TOKEN__ = "secret-token"'),
      true,
    );

    // API and WebSocket (the UI sends no header on either) pass on the
    // cookie alone. The upgrade itself does not complete without websocket
    // headers, so assert only that it is not the guard's refusal.
    const api = await app.fetch(
      new Request("http://127.0.0.1:8000/api/health", { headers: remembered }),
    );
    assertEquals(api.status, 200);
    const ws = await app.fetch(
      new Request("http://127.0.0.1:8000/ws", { headers: remembered }),
    );
    assertEquals(ws.status !== 401 && ws.status !== 403, true);

    // A cookie that does not match (another server instance, a rotated
    // token) is worth nothing; a browser gets an explanation instead of the
    // JSON blob an API client would see.
    // This page is rendered before the app bundle loads, so its text comes
    // straight from the catalogue. Pin the language first: the page loads
    // above already resolved it for real, and every later request follows
    // the stored value (a 401 never writes one).
    core.setSetting(LANGUAGE_KEY, "ja");
    const stale = await app.fetch(
      new Request("http://127.0.0.1:8000/", {
        headers: {
          ...remembered,
          cookie: "lumisca_token_8000=old-token",
          accept: "text/html",
        },
      }),
    );
    assertEquals(stale.status, 401);
    assertEquals((await stale.text()).includes("トークンが必要です"), true);

    const denied = await app.fetch(
      new Request("http://127.0.0.1:8000/api/health", { headers: HOST }),
    );
    assertEquals(denied.status, 401);
    assertEquals(
      (await denied.json()).error,
      "Unauthorized: missing or invalid token",
    );

    // Two servers on one host stay apart: the cookie of the other port is
    // not this server's credential (see auth-cookie.ts).
    const otherPort = await app.fetch(
      new Request("http://127.0.0.1:8000/", {
        headers: {
          host: "127.0.0.1:8000",
          cookie: "lumisca_token_8100=secret-token",
        },
      }),
    );
    assertEquals(otherPort.status, 401);

    // Presenting the token again refreshes a stale cookie.
    const refreshed = await app.fetch(
      new Request("http://127.0.0.1:8000/?token=secret-token", {
        headers: { ...remembered, cookie: "lumisca_token_8000=old-token" },
      }),
    );
    assertEquals(refreshed.status, 200);
    assertEquals(
      (refreshed.headers.get("set-cookie") ?? "").startsWith(
        "lumisca_token_8000=secret-token",
      ),
      true,
    );
  } finally {
    core.close();
  }
});

Deno.test("the MCP OAuth callback is reachable without the token", async () => {
  const faux = fauxProvider();
  const core = LumiscaCore.forTesting([faux.provider]);
  const app = createApp(core, { token: "secret-token" });
  const HOST = { host: "127.0.0.1:8000" };
  try {
    // The browser that comes back from the authorization server may not be
    // the one the app is open in, so it carries no token cookie. The state
    // in the URL is the only credential the callback needs; an unknown one
    // is answered with the sign-in page, not with the guard's 401.
    const callback = await app.fetch(
      new Request(
        "http://127.0.0.1:8000/api/mcp/oauth/callback?state=unknown&code=x",
        { headers: { ...HOST, accept: "text/html" } },
      ),
    );
    assertEquals(callback.status, 404);
    const page = await callback.text();
    assert(page.includes("MCP の認証") || page.includes("MCP sign-in"));

    // Every other MCP path stays behind the token.
    const guarded = await app.fetch(
      new Request("http://127.0.0.1:8000/api/mcp/auth/s1", { headers: HOST }),
    );
    assertEquals(guarded.status, 401);
  } finally {
    core.close();
  }
});

Deno.test("host guard rejects non-loopback hosts by default", async () => {
  const faux = fauxProvider();
  const core = LumiscaCore.forTesting([faux.provider]);
  const app = createApp(core);
  try {
    const remote = await app.fetch(
      new Request("http://127.0.0.1:8000/api/health", {
        headers: { host: "myserver.tailnet.ts.net:8000" },
      }),
    );
    assertEquals(remote.status, 403);
    // Loopback spellings keep working.
    for (const host of ["127.0.0.1:8000", "localhost:8000", "[::1]:8000"]) {
      const ok = await app.fetch(
        new Request("http://127.0.0.1:8000/api/health", {
          headers: { host },
        }),
      );
      assertEquals(ok.status, 200, `host ${host} must be allowed`);
    }
  } finally {
    core.close();
  }
});

Deno.test("host guard accepts LUMISCA_ALLOWED_HOSTS", async () => {
  const faux = fauxProvider();
  const core = LumiscaCore.forTesting([faux.provider]);
  const app = createApp(core, {
    allowedHosts: ["myserver.tailnet.ts.net", "192.168.1.20"],
  });
  try {
    const ok = await app.fetch(
      new Request("http://127.0.0.1:8000/api/health", {
        headers: { host: "myserver.tailnet.ts.net:8000" },
      }),
    );
    assertEquals(ok.status, 200);

    // Hostnames are case-insensitive.
    const mixed = await app.fetch(
      new Request("http://127.0.0.1:8000/api/health", {
        headers: { host: "MyServer.Tailnet.Ts.Net:8000" },
      }),
    );
    assertEquals(mixed.status, 200);

    // The WebSocket guard passes for allowed hosts too (the upgrade itself
    // fails without websocket headers — but not with the host 403).
    const ws = await app.fetch(
      new Request("http://127.0.0.1:8000/ws", {
        headers: { host: "192.168.1.20:8000" },
      }),
    );
    assertEquals(ws.status !== 403, true);

    // Anything not listed stays blocked.
    const other = await app.fetch(
      new Request("http://127.0.0.1:8000/api/health", {
        headers: { host: "other.example.com:8000" },
      }),
    );
    assertEquals(other.status, 403);
  } finally {
    core.close();
  }
});

Deno.test("validateHostConfig requires a token for non-loopback binds", () => {
  assertEquals(validateHostConfig("127.0.0.1", undefined), null);
  assertEquals(validateHostConfig("localhost", undefined), null);
  assertEquals(validateHostConfig("::1", undefined), null);
  assertEquals(validateHostConfig("0.0.0.0", undefined) !== null, true);
  assertEquals(validateHostConfig("0.0.0.0", "token"), null);
  assertEquals(validateHostConfig("100.64.0.5", undefined) !== null, true);
  assertEquals(validateHostConfig("100.64.0.5", "token"), null);
});

Deno.test("websocket rejects cross-origin connections", async () => {
  const faux = fauxProvider();
  const core = LumiscaCore.forTesting([faux.provider]);
  const app = createApp(core);
  try {
    // A malicious website's WS handshake must be refused before the upgrade.
    const evil = await app.fetch(
      new Request("http://127.0.0.1:8000/ws", {
        headers: {
          host: "127.0.0.1:8000",
          origin: "https://evil.example.com",
        },
      }),
    );
    assertEquals(evil.status, 403);

    // Same-origin browsers pass the guard (the upgrade itself fails here
    // without websocket headers — but not with the guard's 403).
    const same = await app.fetch(
      new Request("http://127.0.0.1:8000/ws", {
        headers: { host: "127.0.0.1:8000", origin: "http://127.0.0.1:8000" },
      }),
    );
    assertEquals(
      same.status !== 403,
      true,
      "same-origin must pass the origin guard",
    );
  } finally {
    core.close();
  }
});

Deno.test("websocket accepts a TLS front end's https origin for the same host", async () => {
  // `tailscale serve` (and any TLS-terminating proxy) terminates https and
  // forwards plain http: the page's Origin says https: while the Host this
  // server sees is the same host. Comparing whole origins made that page
  // cross-origin against its own server — the WS was answered 403, the page
  // got no events at all, and the UI fell back to its 10-second snapshot
  // poll (remote sessions arrived seconds late, streaming text never flowed).
  const faux = fauxProvider();
  const core = LumiscaCore.forTesting([faux.provider]);
  const app = createApp(core, {
    token: "t",
    allowedHosts: ["host.tailnet.ts.net"],
  });
  const handshake = async (origin: string | undefined) => {
    const res = await app.fetch(
      new Request("http://host.tailnet.ts.net/ws?token=t", {
        headers: {
          host: "host.tailnet.ts.net",
          ...(origin === undefined ? {} : { origin }),
        },
      }),
    );
    return res.status;
  };
  try {
    assertEquals(await handshake("https://host.tailnet.ts.net"), 404);
    assertEquals(await handshake("http://host.tailnet.ts.net"), 404);
    // The scheme is what stops being compared; the host is not. Another
    // site's https origin is still refused, and so is a real port mismatch.
    assertEquals(await handshake("https://evil.example.com"), 403);
  } finally {
    core.close();
  }
});
