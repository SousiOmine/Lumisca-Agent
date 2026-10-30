import { join } from "node:path";
import { assert, assertEquals } from "@std/assert";
import {
  ATTACHMENTS_DIR_NAME,
  fauxProvider,
  type LumiscaCore,
  LumiscaCore as Core,
} from "@lumisca/core";
import {
  makeRealTempDir,
  MINI_PNG,
  removeDirRetry,
} from "@lumisca/core/test-utils";
import { createApp } from "../app.ts";

/** Host header the fixture requests carry: the app's Host guard refuses a
 * request without one (a real client always sends one). */
const HOST = "127.0.0.1:8000";
const BASE = `http://${HOST}`;

/** Names of the fixture: store-shaped (12 hex characters and an extension). */
const PNG_NAME = "9f3c2a1b4d5e.png";
const TXT_NAME = "0f1e2d3c4b5a.txt";

interface RouteFixture {
  core: LumiscaCore;
  sessionId: string;
  storeDir: string;
  get(path: string): Promise<Response>;
}

/** A file-backed core (so its attachment store sits in a known directory)
 * with one workspace, one session, and two files already stored. */
async function withApp(
  fn: (fixture: RouteFixture) => Promise<void>,
): Promise<void> {
  const dir = await makeRealTempDir("lumisca-attachments-route-");
  const workspaceDir = join(dir, "repo");
  await Deno.mkdir(workspaceDir, { recursive: true });
  const core = Core.open(join(dir, "lumisca.db"), join(dir, "settings.jsonc"));
  try {
    const faux = fauxProvider();
    core.models.models.setProvider(faux.provider);
    const workspace = await core.createWorkspace("ws", [workspaceDir]);
    // Explicit model: the default-model resolution would refuse `faux`.
    const session = await core.createSession({
      workspaceId: workspace.id,
      modelProvider: faux.provider.id,
      modelId: faux.getModel().id,
    });
    // Written directly rather than through the tool: this file is about what
    // the route serves, and the tool has its own test.
    const storeDir = join(dir, ATTACHMENTS_DIR_NAME, session.id);
    await Deno.mkdir(storeDir, { recursive: true });
    await Deno.writeFile(join(storeDir, PNG_NAME), MINI_PNG);
    await Deno.writeTextFile(join(storeDir, TXT_NAME), "the run summary\n");
    await Deno.writeTextFile(
      join(storeDir, `${TXT_NAME}.json`),
      JSON.stringify({ displayName: "summary of the run.txt" }),
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

Deno.test("an attached image is served inline", async () => {
  await withApp(async ({ get, sessionId }) => {
    const res = await get(`/api/sessions/${sessionId}/attachment/${PNG_NAME}`);
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("content-type"), "image/png");
    assertEquals((await res.arrayBuffer()).byteLength, MINI_PNG.byteLength);
    assertEquals(res.headers.get("x-content-type-options"), "nosniff");
    // A browser may show it in place, under the name it was sent as.
    assertEquals(
      res.headers.get("content-disposition"),
      `inline; filename*=UTF-8''${encodeURIComponent(PNG_NAME)}`,
    );
    assertEquals(
      res.headers.get("cache-control"),
      "private, max-age=31536000, immutable",
    );
  });
});

Deno.test("any other attachment is a download under the sender's name", async () => {
  await withApp(async ({ get, sessionId }) => {
    const res = await get(`/api/sessions/${sessionId}/attachment/${TXT_NAME}`);
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("content-type"), "text/plain; charset=utf-8");
    // The store's name is random; the download carries the original, which
    // is what the user recognises in their downloads folder.
    assertEquals(
      res.headers.get("content-disposition"),
      `attachment; filename*=UTF-8''${
        encodeURIComponent("summary of the run.txt")
      }`,
    );
    assertEquals(await res.text(), "the run summary\n");
  });
});

Deno.test("an SVG attachment is a download, never an inline document", async () => {
  await withApp(async ({ get, sessionId, storeDir }) => {
    const name = "1a2b3c4d5e6f.svg";
    await Deno.writeTextFile(join(storeDir, name), "<svg/>");
    const res = await get(`/api/sessions/${sessionId}/attachment/${name}`);
    assertEquals(res.status, 200);
    // Inline SVG could carry script; as a download it is just a file.
    assertEquals(
      res.headers.get("content-disposition")?.startsWith("attachment"),
      true,
    );
    // And the content type is the neutral one, not the script-capable one.
    assertEquals(res.headers.get("content-type"), "application/octet-stream");
  });
});

Deno.test("the route serves only names the session's store made", async () => {
  await withApp(async ({ get, sessionId, storeDir }) => {
    // A file the store never named — even one in the session's own
    // directory — is not reachable.
    await Deno.writeTextFile(join(storeDir, "notes.txt"), "secret");
    for (
      const name of [
        "notes.txt",
        "9f3c2a1b4d5e.pdf",
        "..%2f..%2fnotes.txt",
        "%2Fetc%2Fpasswd",
      ]
    ) {
      const res = await get(`/api/sessions/${sessionId}/attachment/${name}`);
      assertEquals(res.status, 404, `${name} must not be served`);
    }

    const noSession = await get(`/api/sessions/nope/attachment/${PNG_NAME}`);
    assertEquals(noSession.status, 404);
    const unknown = await get(
      `/api/sessions/${sessionId}/attachment/000000000000.png`,
    );
    assertEquals(unknown.status, 404);
    const body = await unknown.json() as { error?: unknown };
    assert(typeof body.error === "string", "the API answers JSON errors");
  });
});
