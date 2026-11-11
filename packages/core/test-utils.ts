/**
 * Shared test helpers: single home for the setup/teardown patterns that
 * used to be copy-pasted across every `*_test.ts`.
 *
 * Test-only module (imports Deno + node:fs); never imported from
 * production code or the browser bundle.
 */

import { realpathSync } from "node:fs";
import { fauxProvider } from "./ai/faux.ts";
import type { Api, ImageContent, Model } from "./ai/types.ts";
import { LumiscaCore } from "./core.ts";
import { CoreError } from "./errors.ts";
import { type Listener, runtime } from "./runtime/runtime.ts";

/**
 * An in-memory core with the faux provider, and the ids a test needs to
 * address its model. Replaces the identical `setup()` that seven
 * `core_*_test.ts` files each carried.
 *
 * `env` replaces the process environment the model layer reads (see
 * LumiscaCore.forTesting), so a test never depends on the machine.
 */
export function setup(env?: () => Record<string, string>): {
  core: LumiscaCore;
  faux: ReturnType<typeof fauxProvider>;
  providerId: string;
  modelId: string;
} {
  const faux = fauxProvider();
  const core = LumiscaCore.forTesting([faux.provider], env);
  return {
    core,
    faux,
    providerId: faux.provider.id,
    modelId: faux.getModel().id,
  };
}

/**
 * A workspace backed by a fresh temp directory. The caller owns the cleanup
 * (see {@link removeDirRetry}) — the temp dir is real, so a session's tools
 * can read and write inside it.
 */
export async function makeWorkspace(
  core: LumiscaCore,
  name = "ws",
): Promise<{
  ws: Awaited<ReturnType<LumiscaCore["createWorkspace"]>>;
  root: string;
}> {
  const root = await makeRealTempDir("lumisca-core-");
  const ws = await core.createWorkspace(name, [root]);
  return { ws, root };
}

/** Minimal 1x1 transparent PNG (67 bytes), e.g. for image-attachment and
 * binary-file tests. */
export const MINI_PNG: Uint8Array = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06,
  0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44,
  0x41, 0x54, 0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d,
  0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42,
  0x60, 0x82,
]);

/**
 * A PNG of `width` x `height` filled with noise: the fixture for the tests
 * that need an image over a byte budget. Noise is what makes a picture big
 * (a solid colour compresses to nothing). `alpha` below 255 makes it
 * transparent.
 *
 * The canvas module is imported here rather than at the top of this file:
 * most suites never need an image, and Skia is a native library (see
 * media/preview.ts for why that matters).
 */
export async function noisyPng(
  width: number,
  height: number,
  alpha = 255,
): Promise<Uint8Array> {
  const { createCanvas } = await import("@napi-rs/canvas");
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  const image = context.createImageData(width, height);
  // A seeded xorshift: the same picture every run, and no repeating motif
  // for the PNG encoder to find.
  let seed = 0x2545f491;
  const next = (): number => {
    seed ^= seed << 13;
    seed >>>= 0;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    seed >>>= 0;
    return seed & 0xff;
  };
  for (let i = 0; i < image.data.length; i += 4) {
    image.data[i] = next();
    image.data[i + 1] = next();
    image.data[i + 2] = next();
    image.data[i + 3] = alpha;
  }
  context.putImageData(image, 0, 0);
  return new Uint8Array(canvas.toBuffer("image/png"));
}

/** Minimal content shape of a tool result; accepts both `{type: string}`
 * and narrower `{type: "text" | "image"}` variants. */
export interface ToolResultLike {
  content: Array<{ type: string; text?: string }>;
}

/** Extract the text of a tool result (concatenated `text` blocks). */
export function toolText(result: ToolResultLike): string {
  return result.content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("");
}

/** Remove a directory, retrying briefly: Windows can hold a directory
 * handle for a moment after a spawned child exits — and a force-killed one
 * holds its working directory until the system tears the process down,
 * which a loaded CI runner stretches — so a single remove flakes there. The
 * window matches the one the background tests already use for a killed
 * process's directory. The last attempt surfaces errors. */
export async function removeDirRetry(path: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      await runtime.remove(path, { recursive: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  await runtime.remove(path, { recursive: true }); // last attempt: surface errors
}

/** Create a temp dir and resolve it to its real path: `makeTempDir` may
 * return 8.3 short names on Windows (e.g. `MAINPC~1`) while the sandbox
 * resolves real paths, so tests must compare against the realpath'd form. */
export async function makeRealTempDir(prefix: string): Promise<string> {
  return realpathSync.native(await runtime.makeTempDir({ prefix }));
}

/** Poll `check` until it holds, or fail naming what was awaited: a test that
 * waits for a process to do something must fail on a hang, never run
 * forever. */
export async function waitUntil(
  check: () => boolean,
  label: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (check()) return;
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Run `fn` with a fresh realpath'd temp dir, always cleaning it up
 * afterwards (via {@link removeDirRetry}). Replaces the
 * `makeTempDir → body → remove` try/finally boilerplate:
 *
 *   await withTempDir("lumisca-foo-", async (root) => {
 *     // ... test body ...
 *   });
 */
export async function withTempDir<T>(
  prefix: string,
  fn: (root: string) => Promise<T> | T,
): Promise<T> {
  const root = await makeRealTempDir(prefix);
  try {
    return await fn(root);
  } finally {
    await removeDirRetry(root);
  }
}

/** Prompt an open session and await the run's completion.
 *
 * Production prompts are fire-and-forget (the server's prompt endpoint
 * returns immediately and the run reports through events), but a test
 * needs to know when the transcript has settled before asserting on it.
 * Wrapping the open agent's `prompt()` keeps that wait in one place
 * instead of spreading event subscriptions across every test. The session
 * must be open: prompting a closed one is a test bug, so it throws.
 * `images` (base64) mirror the HTTP path's image attachments. */
export async function promptSession(
  core: LumiscaCore,
  sessionId: string,
  text: string,
  images?: ImageContent[],
): Promise<void> {
  const agent = core.getAgent(sessionId);
  if (agent === undefined) {
    throw new CoreError(`Session is not open: ${sessionId}`, "not_found");
  }
  await agent.prompt(text, images);
}

/** The lowest port a kernel assigns to a `port: 0` bind on the platforms
 * this project tests on (Linux 32768, macOS and Windows 49152). Nothing
 * below it is ever handed out implicitly. */
const FIRST_EPHEMERAL_PORT = 32768;

/** The band {@link unusedPort} picks from: below the ephemeral range above
 * (with a margin, so a platform whose range starts a little lower is still
 * covered) and above the ports a development machine tends to hold (the dev
 * server's 8000), so the check below rarely has to walk far. */
const UNUSED_PORT_FIRST = 20000;
const UNUSED_PORT_LAST = FIRST_EPHEMERAL_PORT - 1000;

/** A port number that stays unused while a test uses it. The number itself
 * is the reservation, which is what a test needs when the consumer binds
 * the port (a command under test) or must find nobody listening on it (a
 * connection that has to be refused).
 *
 * `runtime.listen({ port: 0 })` cannot serve that: the kernel picks out of the
 * ephemeral range and the port is free for anyone the moment the listener
 * closes, so with the suite running in parallel another test's socket can
 * be handed that exact number in between. A loaded CI runner did exactly
 * that to the systemd install tests (`ポート 49353 は既に使用中です`). A
 * number from the band above is never handed out implicitly, so between the
 * check here and the test's use only an explicit bind of that exact port
 * could take it; the check — on the wildcard address, so a listener on any
 * interface is caught — proves nothing holds it now.
 *
 * The scan starts at a random point: tests in other files run in parallel
 * and would otherwise be handed the same number. */
export function unusedPort(): number {
  const span = UNUSED_PORT_LAST - UNUSED_PORT_FIRST;
  const start = UNUSED_PORT_FIRST + Math.floor(Math.random() * span);
  for (let step = 0; step < span; step++) {
    const port = UNUSED_PORT_FIRST + ((start + step) % span);
    let listener: Listener;
    try {
      listener = runtime.listen({ hostname: "0.0.0.0", port });
    } catch (error) {
      // "Someone holds this number" — the next one may be free. Anything
      // else is a problem with the bind itself and must surface. The name
      // check mirrors the server's own classifier
      // (packages/server/startup.ts), which allows for a listen failure
      // that arrives as a plain Error.
      if (
        error instanceof runtime.errors.AddrInUse ||
        (error instanceof Error && error.name === "AddrInUse")
      ) {
        continue;
      }
      throw error;
    }
    listener.close();
    return port;
  }
  throw new Error(
    `unusedPort: every port in ${UNUSED_PORT_FIRST}-${UNUSED_PORT_LAST} is held`,
  );
}

/**
 * A model stand-in for tests that never reach a provider: only the fields the
 * caller reads are real, and the SDK shape is faked. `id` is what assertions
 * compare; `extra` carries the api/provider fields a test that inspects the
 * request needs.
 */
export function fakeModel(
  id = "m",
  extra: Record<string, unknown> = {},
): Model<Api> {
  return { id, name: id, ...extra } as unknown as Model<Api>;
}
