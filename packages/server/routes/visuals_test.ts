import { join } from "node:path";
import { assert, assertEquals } from "@std/assert";
import {
  fauxProvider,
  type LumiscaCore,
  LumiscaCore as Core,
  VISUALS_DIR_NAME,
} from "@lumisca/core";
import {
  makeRealTempDir,
  MINI_PNG,
  removeDirRetry,
} from "@lumisca/core/test-utils";
import { createApp } from "../app.ts";
import { tokenCookieName } from "../auth-cookie.ts";

/** Host header the fixture requests carry: the app's Host guard refuses a
 * request without one (a real client always sends it). */
const HOST = "127.0.0.1:8000";
const BASE = `http://${HOST}`;

/** Asset names of the fixture. Both are store-shaped: 12 hex characters and
 * a supported extension. */
const PNG_NAME = "9f3c2a1b4d5e.png";
const SVG_NAME = "0f1e2d3c4b5a.svg";

interface RouteFixture {
  core: LumiscaCore;
  sessionId: string;
  /** The session's visual store directory. */
  storeDir: string;
  /** GET one path of the default app (no auth), as a browser would. */
  get(path: string): Promise<Response>;
}

/** A file-backed core — so its visual store sits in a known directory — with
 * one workspace, one session, and two assets already in that store. */
async function withApp(
  fn: (fixture: RouteFixture) => Promise<void>,
): Promise<void> {
  const dir = await makeRealTempDir("lumisca-visuals-route-");
  const workspaceDir = join(dir, "repo");
  await Deno.mkdir(workspaceDir, { recursive: true });
  const core = Core.open(join(dir, "lumisca.db"), join(dir, "settings.jsonc"));
  try {
    const faux = fauxProvider();
    core.models.models.setProvider(faux.provider);
    const workspace = await core.createWorkspace("ws", [workspaceDir]);
    // Explicit model: the default-model resolution would refuse `faux`
    // (nothing is configured in this core's settings).
    const session = await core.createSession({
      workspaceId: workspace.id,
      modelProvider: faux.provider.id,
      modelId: faux.getModel().id,
    });
    // Written directly rather than through the visual tool: this file is
    // about what the route serves, and the tool has its own test.
    const storeDir = join(dir, VISUALS_DIR_NAME, session.id);
    await Deno.mkdir(storeDir, { recursive: true });
    await Deno.writeFile(join(storeDir, PNG_NAME), MINI_PNG);
    await Deno.writeFile(
      join(storeDir, SVG_NAME),
      new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" />'),
    );
    const app = createApp(core, { repoRoot: Deno.cwd() });
    const get = async (path: string) =>
      await app.request(`${BASE}${path}`, { headers: { host: HOST } });
    await fn({ core, sessionId: session.id, storeDir, get });
  } finally {
    await core.close();
    await removeDirRetry(dir);
  }
}

Deno.test("the asset route serves a published image", async () => {
  await withApp(async ({ get, sessionId }) => {
    const res = await get(`/api/sessions/${sessionId}/visual/${PNG_NAME}`);
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("content-type"), "image/png");
    // The bytes are what the session published, not a re-encoding.
    assertEquals((await res.arrayBuffer()).byteLength, MINI_PNG.byteLength);
    assertEquals(res.headers.get("x-content-type-options"), "nosniff");
    // A name is fresh per publish and never reused, so the answer is
    // immutable: re-rendering the transcript reuses the browser's copy.
    assertEquals(
      res.headers.get("cache-control"),
      "private, max-age=31536000, immutable",
    );
  });
});

Deno.test("an SVG asset carries a policy of its own", async () => {
  await withApp(async ({ get, sessionId }) => {
    const res = await get(`/api/sessions/${sessionId}/visual/${SVG_NAME}`);
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("content-type"), "image/svg+xml");
    // Opened as a document of its own (a new tab), an SVG would otherwise
    // run with the app's origin: the response allows nothing.
    assertEquals(
      res.headers.get("content-security-policy"),
      "default-src 'none'; sandbox",
    );
  });
});

Deno.test("the asset route serves only the session's own assets", async () => {
  await withApp(async ({ get, sessionId, storeDir }) => {
    // A file the store never named — even one sitting in the session's own
    // directory — is not reachable.
    await Deno.writeTextFile(join(storeDir, "notes.txt"), "secret");
    for (
      const name of [
        "notes.txt",
        "9f3c2a1b4d5e.pdf",
        "9f3c2a1b4d5e.png.bak",
        // An encoded traversal reaches the route as one segment, and the
        // store refuses it like any other malformed name.
        "..%2f..%2fnotes.txt",
        "%2Fetc%2Fpasswd",
      ]
    ) {
      const res = await get(`/api/sessions/${sessionId}/visual/${name}`);
      assertEquals(res.status, 404, `${name} must not be served`);
    }

    // An unknown session, and a well-formed name that was never published:
    // both are 404 with the API's JSON error body.
    const noSession = await get(`/api/sessions/nope/visual/${PNG_NAME}`);
    assertEquals(noSession.status, 404);
    const unknown = await get(
      `/api/sessions/${sessionId}/visual/000000000000.png`,
    );
    assertEquals(unknown.status, 404);
    const body = await unknown.json() as { error?: unknown };
    assert(typeof body.error === "string", "the API answers JSON errors");
  });
});

Deno.test("a cookie is enough: an <img> can send nothing else", async () => {
  await withApp(async ({ core, sessionId }) => {
    const token = "s3cret-token";
    const app = createApp(core, { repoRoot: Deno.cwd(), token });
    const path = `/api/sessions/${sessionId}/visual/${PNG_NAME}`;
    const request = async (headers: Record<string, string>) =>
      await app.request(`${BASE}${path}`, {
        headers: { host: HOST, ...headers },
      });

    // No credential: refused, exactly like the rest of /api.
    assertEquals((await request({})).status, 401);

    // The browser stores the cookie when it opens a `?token=` URL, and an
    // <img> request — which cannot carry the header — then succeeds.
    const cookieName = tokenCookieName(HOST);
    const withCookie = await request({ cookie: `${cookieName}=${token}` });
    assertEquals(withCookie.status, 200);
    assertEquals(withCookie.headers.get("content-type"), "image/png");
    // A cookie from another instance (a different port) is a different name:
    // it must not authenticate here.
    assertEquals(
      (await request({ cookie: `lumisca_token_8100=${token}` })).status,
      401,
    );
  });
});
