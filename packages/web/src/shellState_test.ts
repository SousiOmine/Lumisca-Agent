/**
 * The shell state, read once and shared.
 *
 * `shell.ts` captures the bridge origin when it loads (it is injected as the
 * page's initialization script, so it is there before any module runs). This
 * file therefore has no top-level import of it: the global is set first, and
 * the module is imported afterwards. A test that imported `shell.ts` at the
 * top would see "the desktop shell is not available" for the rest of the
 * run.
 */
import { assertEquals } from "@std/assert";

/** The bridge origin the page would have in a desktop window. */
(globalThis as unknown as Record<string, unknown>).__LUMISCA_BRIDGE__ =
  "http://127.0.0.1:9/shell";

const { shellState } = await import("./shell.ts");

/** The state the stub bridge answers. */
const SHELL_STATE = {
  mode: "local",
  url: null,
  name: null,
  maximized: false,
  platform: "linux",
};

/** Run `body` with `fetch` replaced by a stub answering SHELL_STATE. */
async function withBridge(
  body: (calls: string[]) => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = ((input: string) => {
    calls.push(String(input));
    return Promise.resolve(
      new Response(JSON.stringify(SHELL_STATE), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch;
  try {
    await body(calls);
  } finally {
    globalThis.fetch = original;
    shellState.reset();
  }
}

Deno.test("shellState: one bridge call serves every reader", async () => {
  // The title bar, the connection picker and the settings list all ask for
  // the same state; before this source existed each mount paid its own round
  // trip (and the trigger needed the answer while its popover was closed).
  await withBridge(async (calls) => {
    shellState.reset();
    const [a, b] = await Promise.all([shellState.read(), shellState.read()]);
    assertEquals(a, b);
    assertEquals(calls.length, 1, "two readers share one bridge call");
    // A reset asks again (after a connection switch the page reloads; a test
    // harness changes the bridge under it).
    shellState.reset();
    await shellState.read();
    assertEquals(calls.length, 2);
  });
});

Deno.test("shellState: a failed read is not cached", async () => {
  const original = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = (() => {
    attempts++;
    // The first mount of a cold window can outrun the bridge.
    if (attempts === 1) return Promise.reject(new Error("not listening yet"));
    return Promise.resolve(
      new Response(JSON.stringify(SHELL_STATE), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch;
  try {
    shellState.reset();
    let failed = false;
    await shellState.read().catch(() => {
      failed = true;
    });
    assertEquals(failed, true);
    const state = await shellState.read();
    assertEquals(state.mode, "local", "the second read retries the bridge");
  } finally {
    globalThis.fetch = original;
    shellState.reset();
  }
});
