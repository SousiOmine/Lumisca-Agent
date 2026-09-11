/**
 * Shared test helpers: single home for the setup/teardown patterns that
 * used to be copy-pasted across every `*_test.ts`.
 *
 * Test-only module (imports Deno + node:fs); never imported from
 * production code or the browser bundle.
 */
import { realpathSync } from "node:fs";
import { CoreError } from "./errors.ts";
import type { LumiscaCore } from "./core.ts";
import type { ImageContent } from "./ai/types.ts";

/** Minimal 1x1 transparent PNG (67 bytes), e.g. for image-attachment and
 * binary-file tests. */
export const MINI_PNG: Uint8Array = new Uint8Array([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
  0x00,
  0x00,
  0x00,
  0x0d,
  0x49,
  0x48,
  0x44,
  0x52,
  0x00,
  0x00,
  0x00,
  0x01,
  0x00,
  0x00,
  0x00,
  0x01,
  0x08,
  0x06,
  0x00,
  0x00,
  0x00,
  0x1f,
  0x15,
  0xc4,
  0x89,
  0x00,
  0x00,
  0x00,
  0x0d,
  0x49,
  0x44,
  0x41,
  0x54,
  0x78,
  0x9c,
  0x62,
  0x00,
  0x01,
  0x00,
  0x00,
  0x05,
  0x00,
  0x01,
  0x0d,
  0x0a,
  0x2d,
  0xb4,
  0x00,
  0x00,
  0x00,
  0x00,
  0x49,
  0x45,
  0x4e,
  0x44,
  0xae,
  0x42,
  0x60,
  0x82,
]);

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
 * handle for a moment after a spawned child exits, so a single remove
 * flakes there. The last attempt surfaces errors. */
export async function removeDirRetry(path: string): Promise<void> {
  for (let i = 0; i < 20; i++) {
    try {
      await Deno.remove(path, { recursive: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  await Deno.remove(path, { recursive: true }); // last attempt: surface errors
}

/** Create a temp dir and resolve it to its real path: `makeTempDir` may
 * return 8.3 short names on Windows (e.g. `MAINPC~1`) while the sandbox
 * resolves real paths, so tests must compare against the realpath'd form. */
export async function makeRealTempDir(prefix: string): Promise<string> {
  return realpathSync(await Deno.makeTempDir({ prefix }));
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
