/**
 * The IPC fallback of `shellCall`.
 *
 * `shell.ts` captures the bridge origin, the auth token and Tauri's `invoke`
 * when it loads, so this file sets the globals first and imports the module
 * dynamically (the same reason as shellState_test.ts).
 */
import { assertEquals } from "@std/assert";

const globals = globalThis as unknown as Record<string, unknown>;
globals.__LUMISCA_BRIDGE__ = "http://127.0.0.1:9/shell";
globals.__LUMISCA_TOKEN__ = "token";

interface Invocation {
  command: string;
  args: { action: string; params: Record<string, string> };
}

let invocations: Invocation[] = [];
globals.__TAURI_INTERNALS__ = {
  invoke: (command: string, args: Invocation["args"]) => {
    invocations.push({ command, args });
    return Promise.resolve({ ok: true });
  },
};

const { shellCall } = await import("./shell.ts");

/** Run `body` with `fetch` replaced, restoring it afterwards. */
async function withFetch(
  impl: typeof fetch,
  body: () => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    await body();
  } finally {
    globalThis.fetch = original;
  }
}

Deno.test("shellCall: a transport failure falls back to Tauri IPC", async () => {
  invocations = [];
  await withFetch(
    // What WebKit reports for a mixed-content fetch from an HTTPS page.
    () => Promise.reject(new TypeError("Load failed")),
    async () => {
      const result = await shellCall<{ ok: boolean }>("state");
      assertEquals(result, { ok: true });
      assertEquals(invocations, [
        {
          command: "shell_action",
          args: { action: "state", params: { key: "token" } },
        },
      ]);
    },
  );
});

Deno.test("shellCall: an HTTP error is not replayed over IPC", async () => {
  invocations = [];
  await withFetch(
    () =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "invalid key" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
      ),
    async () => {
      let message = "";
      await shellCall("state").catch((error) => {
        message = error instanceof Error ? error.message : String(error);
      });
      assertEquals(message, "invalid key");
      assertEquals(invocations.length, 0, "the action already answered");
    },
  );
});

Deno.test("shellCall: a page without a bridge origin still reaches IPC", async () => {
  // The initialization script normally sets both; if only the bridge origin
  // is missing, IPC is still a working road to the shell.
  invocations = [];
  const withBridge = globals.__LUMISCA_BRIDGE__;
  globals.__LUMISCA_BRIDGE__ = undefined;
  try {
    const { shellCall: shellCallWithoutBridge } = await import(
      "./shell.ts?without-bridge"
    );
    const result = await shellCallWithoutBridge<{ ok: boolean }>("state");
    assertEquals(result, { ok: true });
    assertEquals(invocations, [
      {
        command: "shell_action",
        args: { action: "state", params: { key: "token" } },
      },
    ]);
  } finally {
    globals.__LUMISCA_BRIDGE__ = withBridge;
  }
});

Deno.test("shellCall: without IPC the transport failure surfaces", async () => {
  // A fresh module instance: `invoke` is captured at import time, so the
  // first module's ordinary fallback cannot be removed from under it.
  const withIpc = globals.__TAURI_INTERNALS__;
  globals.__TAURI_INTERNALS__ = undefined;
  try {
    const { shellCall: shellCallWithoutIpc } = await import(
      "./shell.ts?without-ipc"
    );
    await withFetch(
      () => Promise.reject(new TypeError("Load failed")),
      async () => {
        let message = "";
        await shellCallWithoutIpc("state").catch((error) => {
          message = error instanceof Error ? error.message : String(error);
        });
        assertEquals(message, "Load failed");
      },
    );
  } finally {
    globals.__TAURI_INTERNALS__ = withIpc;
  }
});
