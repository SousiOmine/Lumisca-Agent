import { fauxProvider } from "@lumisca/core";
import { assert, assertEquals } from "@std/assert";
import { LumiscaCore } from "@lumisca/core";
import { LANGUAGE_KEY, THEME_COLORS } from "@lumisca/core/shared";
import { createApp, startServer } from "./app.ts";

export function json(
  base: string,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return fetch(`${base}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
}

Deno.test("unknown static assets return 404, not the HTML shell", async () => {
  const faux = fauxProvider();
  const core = LumiscaCore.forTesting([faux.provider]);
  const server = startServer(core, 0, { repoRoot: Deno.cwd() });
  try {
    const base = `http://127.0.0.1:${server.addr.port}`;
    const favicon = await fetch(`${base}/favicon.ico`);
    assertEquals(favicon.status, 404);
    const png = await fetch(`${base}/favicon.png`);
    assertEquals(png.status, 200);
    assertEquals(png.headers.get("content-type"), "image/png");
    assertEquals((await png.arrayBuffer()).byteLength > 0, true);
    // The favicon follows the same cache rule as the app's other files: a
    // validator to revalidate against, not a bare content-type (it is on the
    // token-free list, so every page load may ask for it).
    const faviconEtag = png.headers.get("etag");
    assert(faviconEtag !== null, "the favicon must carry a validator");
    assertEquals(
      png.headers.get("cache-control"),
      "private, max-age=0, must-revalidate",
    );
    const revalidated = await fetch(`${base}/favicon.png`, {
      headers: { "if-none-match": faviconEtag },
    });
    assertEquals(revalidated.status, 304);
    assertEquals(await revalidated.text(), "");
    const stale = await fetch(`${base}/assets/app.deadbeef.js`);
    assertEquals(stale.status, 404);
    const content = await stale.text();
    assertEquals(content.includes("__INITIAL_DATA__"), false);
    // The route answers from the manifest, never from a path: an encoded
    // traversal decodes into a `:file` value and misses like any other name.
    const traversal = await fetch(`${base}/assets/..%2f..%2fetc%2fpasswd`);
    assertEquals(traversal.status, 404);
    assertEquals((await traversal.text()).includes("root:"), false);
    // A prototype member is not a file either (the manifest is a plain
    // object, so a lookup that did not ask for an own property would answer
    // with `Object.prototype.constructor`).
    assertEquals((await fetch(`${base}/assets/constructor`)).status, 404);
  } finally {
    server.shutdown();
    core.close();
  }
});

Deno.test("server serves the app shell", async () => {
  const faux = fauxProvider();
  const core = LumiscaCore.forTesting([faux.provider]);
  const server = startServer(core, 0, { repoRoot: Deno.cwd() });
  try {
    const base = `http://127.0.0.1:${server.addr.port}`;
    // The language is resolved per request; the header pins it so the test
    // does not depend on the machine's locale.
    const index = await fetch(`${base}/`, {
      headers: { "accept-language": "ja-JP,ja;q=0.9" },
    });
    assertEquals(index.status, 200);
    const html = await index.text();
    // Static shell: an empty #root (the app renders client-side), the
    // externalized initial data (inline scripts are banned by the page
    // CSP), and the client bundle script.
    assertEquals(html.includes('<div id="root"></div>'), true);
    assertEquals(html.includes('src="/assets/initial-data.js"'), true);
    assertEquals(html.includes('src="/assets/app.js"'), true);
    assertEquals(html.includes("styles.css") || html.includes("<style>"), true);
    // The document already declares the app language (font fallback,
    // hyphenation, screen readers) before the client bundle runs.
    assertEquals(html.includes('<html lang="ja"'), true);
    // The desktop shell bridge (title bar: window controls and the
    // connection picker) is allowed by the CSP; in plain browsers nothing
    // listens there and the bridge is unused.
    assertEquals(html.includes("http://127.0.0.1:*"), true);

    // The initial-data script carries the serialized state, the language
    // included — the client seeds its catalogue with it before the first
    // render, so the UI never flashes the wrong language.
    const dataScript = await fetch(`${base}/assets/initial-data.js`);
    assertEquals(dataScript.status, 200);
    const dataText = await dataScript.text();
    assertEquals(dataText.includes("window.__INITIAL_DATA__"), true);
    assertEquals(dataText.includes('"language":"ja"'), true);

    // SPA fallback renders the same shell.
    const fallback = await fetch(`${base}/some/route`);
    assertEquals(fallback.status, 200);
    assertEquals((await fallback.text()).includes('id="root"'), true);

    // API must not be shadowed.
    const health = await fetch(`${base}/api/health`);
    assertEquals(health.status, 200);
    assertEquals((await health.json()).ok, true);
  } finally {
    server.shutdown();
    core.close();
  }
});

Deno.test("token-required page renders in the request's language", async () => {
  const faux = fauxProvider();
  const core = LumiscaCore.forTesting([faux.provider]);
  const app = createApp(core, { token: "secret-token" });
  const host = { host: "127.0.0.1:8000" };
  try {
    // Nothing is stored yet and no app page has been loaded, so the
    // browser's own preference decides — the only hint a page served
    // before the app exists can have.
    const ja = await app.fetch(
      new Request("http://127.0.0.1:8000/", {
        headers: { ...host, accept: "text/html", "accept-language": "ja-JP" },
      }),
    );
    assertEquals(ja.status, 401);
    assertEquals((await ja.text()).includes("トークンが必要です"), true);

    const en = await app.fetch(
      new Request("http://127.0.0.1:8000/", {
        headers: {
          ...host,
          accept: "text/html",
          "accept-language": "en-US,en;q=0.9",
        },
      }),
    );
    assertEquals(en.status, 401);
    assertEquals((await en.text()).includes("A token is required"), true);

    // A 401 is not a page load of the app: it resolved a language for its
    // own response but stored nothing, so the first real page load still
    // decides (and no later request inherits a guess from a rejected one).
    assertEquals(core.getSetting(LANGUAGE_KEY), undefined);
  } finally {
    core.close();
  }
});

Deno.test("server resolves the app language once and stores it", async () => {
  const faux = fauxProvider();
  const core = LumiscaCore.forTesting([faux.provider]);
  const server = startServer(core, 0, { repoRoot: Deno.cwd() });
  try {
    const base = `http://127.0.0.1:${server.addr.port}`;

    // First load: nothing is stored yet, so the browser's preference
    // decides — and the resolved value is remembered, because the language
    // must not depend on which client happens to create the next session.
    const first = await fetch(`${base}/`, {
      headers: { "accept-language": "en-US,en;q=0.9" },
    });
    assertEquals((await first.text()).includes('<html lang="en"'), true);
    const settings = await (await fetch(`${base}/api/settings`)).json();
    assertEquals(settings.language, "en");

    // A later request with a different preference does not flip it: the
    // stored setting is the source of truth, and the settings dialog is
    // its only writer after this point.
    const second = await fetch(`${base}/`, {
      headers: { "accept-language": "ja" },
    });
    assertEquals((await second.text()).includes('<html lang="en"'), true);

    // The user's explicit choice wins over every fallback.
    await fetch(`${base}/api/settings/language`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "ja" }),
    });
    const third = await fetch(`${base}/`);
    assertEquals((await third.text()).includes('<html lang="ja"'), true);
    const data = await fetch(`${base}/assets/initial-data.js`);
    assertEquals((await data.text()).includes('"language":"ja"'), true);

    // An unknown stored value is "not chosen": it is replaced by the
    // resolved language instead of reaching the page.
    await fetch(`${base}/api/settings/language`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "fr" }),
    });
    const fourth = await fetch(`${base}/`, {
      headers: { "accept-language": "ja" },
    });
    assertEquals((await fourth.text()).includes('<html lang="ja"'), true);
  } finally {
    server.shutdown();
    core.close();
  }
});

Deno.test("server bundles and serves the client app", async () => {
  const faux = fauxProvider();
  const core = LumiscaCore.forTesting([faux.provider]);
  const server = startServer(core, 0, { repoRoot: Deno.cwd() });
  try {
    const base = `http://127.0.0.1:${server.addr.port}`;
    const res = await fetch(`${base}/assets/app.js`);
    assertEquals(res.status, 200);
    const js = await res.text();
    // The entry point is what proves the bundle is the app rather than an
    // empty or stale file; a byte count only ever approximated that (it
    // breaks whenever the UI happens to shrink and passes for a bundle that
    // compiled the wrong entry).
    assertEquals(js.includes("input-composer"), true);
    assert(
      js.length > 10_000,
      `the bundle is ${js.length} bytes: too small to hold the client app`,
    );
  } finally {
    server.shutdown();
    core.close();
  }
});

Deno.test("the client's chunks are served and the entry loads them lazily", async () => {
  const faux = fauxProvider();
  const core = LumiscaCore.forTesting([faux.provider]);
  const server = startServer(core, 0, { repoRoot: Deno.cwd() });
  try {
    const base = `http://127.0.0.1:${server.addr.port}`;
    const entry = await (await fetch(`${base}/assets/app.js`)).text();
    // Splitting is what keeps noVNC and motion off the first load: the entry
    // must reference a chunk by a relative dynamic import instead of holding
    // their code. A build without `splitting` inlines both and the entry
    // names neither.
    const chunks = [...entry.matchAll(/import\("\.\/([^"]+\.js)"\)/g)].map(
      (match) => match[1]!,
    );
    assert(chunks.length > 0, "the entry has no dynamic import");

    // Each named chunk is a real route answer, not a 404 the browser would
    // discover only when the reader opens the stella screen.
    for (const name of chunks) {
      const res = await fetch(`${base}/assets/${name}`);
      assertEquals(res.status, 200, `${name} was not served`);
      assertEquals(
        res.headers.get("content-type"),
        "application/javascript; charset=utf-8",
      );
      assert((await res.text()).length > 0, `${name} is empty`);
    }
    // The chunks the build makes are the dynamic imports the entry names:
    // noVNC for the stella screen, motion/mini for an exit animation.
    assertEquals(chunks.some((name) => name.startsWith("rfb-")), true);
    assertEquals(chunks.some((name) => name.startsWith("mini-")), true);
  } finally {
    server.shutdown();
    core.close();
  }
});

Deno.test("the app's files are compressed and revalidated", async () => {
  // The app is opened over a tailnet or a WAN as often as on loopback, and
  // everything it serves is text: the bundle is ~600 KB, the stylesheet is
  // inlined into the page (~140 KB), and JSON snapshots repeat. Without
  // compression each of those is several times its size on the wire, and
  // without a validator every reload pays for it in full.
  const faux = fauxProvider();
  const core = LumiscaCore.forTesting([faux.provider]);
  const server = startServer(core, 0, { repoRoot: Deno.cwd() });
  try {
    const base = `http://127.0.0.1:${server.addr.port}`;
    // `fetch` decodes transparently, so the header is what proves the work
    // happened (and the decoded body is still the app).
    const gz = await fetch(`${base}/assets/app.js`, {
      headers: { "accept-encoding": "gzip" },
    });
    assertEquals(gz.headers.get("content-encoding"), "gzip");
    const js = await gz.text();
    assertEquals(js.includes("input-composer"), true);
    // The page is text too. (The stylesheet has no route of its own: the page
    // carries it inline in a `<style>` element.)
    for (const path of ["/"]) {
      const res = await fetch(`${base}${path}`, {
        headers: { "accept-encoding": "gzip" },
      });
      assertEquals(
        res.headers.get("content-encoding"),
        "gzip",
        `${path} was not compressed`,
      );
    }

    // A stable URL gets a validator and re-checks: the second read is a
    // bodyless 304, which is what a reload costs instead of the payload.
    const first = await fetch(`${base}/assets/app.js`);
    const etag = first.headers.get("etag");
    assert(etag !== null, "the bundle carries no validator");
    assert(first.headers.get("cache-control")?.includes("private") === true);
    const revalidated = await fetch(`${base}/assets/app.js`, {
      headers: { "if-none-match": etag },
    });
    assertEquals(revalidated.status, 304);
    assertEquals((await revalidated.arrayBuffer()).byteLength, 0);

    // The page and the bootstrap script carry the auth token: nothing may
    // keep a copy.
    for (const path of ["/", "/assets/initial-data.js"]) {
      const res = await fetch(`${base}${path}`);
      assertEquals(
        res.headers.get("cache-control"),
        "no-store",
        `${path} is cacheable`,
      );
    }
  } finally {
    server.shutdown();
    core.close();
  }
});

Deno.test("the PWA surface is installable and never secret", async () => {
  const faux = fauxProvider();
  const core = LumiscaCore.forTesting([faux.provider]);
  const server = startServer(core, 0, { repoRoot: Deno.cwd() });
  try {
    const base = `http://127.0.0.1:${server.addr.port}`;
    // The manifest is generated per request: it reports the theme colour
    // this page starts in (dark is the default) and is valid JSON.
    const manifestRes = await fetch(`${base}/manifest.webmanifest`);
    assertEquals(manifestRes.status, 200);
    assertEquals(
      manifestRes.headers.get("content-type"),
      "application/manifest+json",
    );
    const manifest = await manifestRes.json() as {
      start_url?: string;
      display?: string;
      theme_color?: string;
      icons?: { src: string; sizes: string }[];
    };
    assertEquals(manifest.start_url, "/");
    assertEquals(manifest.display, "standalone");
    assertEquals(manifest.theme_color, THEME_COLORS.dark);
    assertEquals(manifest.icons?.length, 3);

    // Each icon it names is a real PNG at the size the manifest claims: a
    // browser decodes them and reports the app as not installable on a
    // mismatch.
    for (const icon of manifest.icons ?? []) {
      const response = await fetch(`${base}${icon.src}`);
      assertEquals(response.status, 200, icon.src);
      assertEquals(response.headers.get("content-type"), "image/png");
      const bytes = new Uint8Array(await response.arrayBuffer());
      assertEquals(
        [...bytes.subarray(0, 8)],
        [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
        icon.src,
      );
      // The PNG header carries width and height big-endian at 16..24.
      const view = new DataView(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength,
      );
      assertEquals(`${view.getUint32(16)}x${view.getUint32(20)}`, icon.sizes);
    }

    // Revalidated like the favicon: an unguarded file is asked for on every
    // page load, and it changes only with a release.
    const first = await fetch(`${base}/pwa/icon-192.png`);
    const etag = first.headers.get("etag");
    assert(etag !== null, "a PWA icon must carry a validator");
    const revalidated = await fetch(`${base}/pwa/icon-192.png`, {
      headers: { "if-none-match": etag },
    });
    assertEquals(revalidated.status, 304);

    // iOS reads the touch icon from the page's <link>, so it is served too.
    assertEquals(
      (await fetch(`${base}/pwa/apple-touch-icon.png`)).status,
      200,
    );
    // Anything else under /pwa/ is not a file of this build, and must not
    // fall through to the app shell.
    const unknown = await fetch(`${base}/pwa/icon-1024.png`);
    assertEquals(unknown.status, 404);
    assertEquals(
      unknown.headers.get("content-type"),
      "text/plain; charset=UTF-8",
    );

    // The service worker is a standalone script (not a module: Safari
    // refuses module workers) with a fetch handler, which is what Chromium
    // checks before it offers the install prompt. It must never carry the
    // token — it is on the token-free list.
    const sw = await fetch(`${base}/sw.js`);
    assertEquals(sw.status, 200);
    assertEquals(
      sw.headers.get("content-type"),
      "application/javascript; charset=utf-8",
    );
    const swBody = await sw.text();
    assertEquals(swBody.includes('addEventListener("fetch"'), true);
    assertEquals(swBody.includes("__LUMISCA_TOKEN__"), false);
    // `initial-data.js` carries the token, so the worker names it only to
    // exclude it.
    assertEquals(swBody.includes("initial-data.js"), true);

    // The page points at all of it.
    const html = await (await fetch(`${base}/`)).text();
    assertEquals(html.includes('rel="manifest"'), true);
    assertEquals(html.includes("/pwa/apple-touch-icon.png"), true);
  } finally {
    server.shutdown();
    core.close();
  }
});
