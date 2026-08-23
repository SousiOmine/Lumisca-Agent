import { assert, assertEquals, assertMatch } from "@std/assert";
import { LazyBrowserBackend } from "./lazy.ts";
import type { BrowserBackend } from "./types.ts";

class Stub implements BrowserBackend {
  closed = false;
  open(): Promise<{ url: string }> {
    return Promise.resolve({ url: "http://127.0.0.1:1/" });
  }
  observe(): Promise<never> {
    return Promise.reject(new Error("not used"));
  }
  act(): Promise<never> {
    return Promise.reject(new Error("not used"));
  }
  wait(): Promise<never> {
    return Promise.reject(new Error("not used"));
  }
  screenshot(): Promise<never> {
    return Promise.reject(new Error("not used"));
  }
  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

async function expectThrow(
  fn: () => Promise<unknown>,
  pattern?: RegExp,
): Promise<Error> {
  let error: Error;
  try {
    await fn();
    throw new Error("expected the call to throw");
  } catch (e) {
    error = e instanceof Error ? e : new Error(String(e));
  }
  if (pattern !== undefined) assertMatch(error.message, pattern);
  return error;
}

Deno.test("the factory runs on the first call, exactly once", async () => {
  let spawns = 0;
  const lazy = new LazyBrowserBackend(() => {
    spawns++;
    return Promise.resolve(new Stub());
  });
  assertEquals(lazy.isStarted, false);
  const first = await lazy.open({ url: "http://127.0.0.1:1/" });
  assertEquals(first.url, "http://127.0.0.1:1/");
  await lazy.observe().catch(() => {});
  assertEquals(spawns, 1, "one host per lifecycle");
  assertEquals(lazy.isStarted, true);
});

Deno.test("close releases the host; a later call starts a fresh one", async () => {
  const closed: Stub[] = [];
  const lazy = new LazyBrowserBackend(() => {
    const stub = new Stub();
    closed.push(stub);
    return Promise.resolve(stub);
  });
  await lazy.open({ url: "http://127.0.0.1:1/" });
  await lazy.close();
  assertEquals(closed[0]!.closed, true);
  await lazy.open({ url: "http://127.0.0.1:1/" });
  assertEquals(closed.length, 2, "open after close = new lifecycle");
  await lazy.close();
  assertEquals(closed[1]!.closed, true);
});

Deno.test("close is idempotent and safe before any launch", async () => {
  const lazy = new LazyBrowserBackend(() => Promise.resolve(new Stub()));
  await lazy.close();
  await lazy.close();
  assertEquals(lazy.isStarted, false);
});

Deno.test("a failed launch stays failed until close — no silent retry", async () => {
  let attempts = 0;
  const lazy = new LazyBrowserBackend(() => {
    attempts++;
    return Promise.reject(new Error("no display available"));
  });
  const first = await expectThrow(
    () => lazy.open({ url: "http://127.0.0.1:1/" }),
    /no display available/,
  );
  assert(first instanceof Error);
  await expectThrow(
    () => lazy.open({ url: "http://127.0.0.1:1/" }),
    /no display available/,
  );
  assertEquals(attempts, 1, "a failed launch must not be retried silently");
  // close() clears the failed state — the next open is an explicit new
  // lifecycle, allowed to try again.
  await lazy.close();
  await expectThrow(
    () => lazy.open({ url: "http://127.0.0.1:1/" }),
    /no display available/,
  );
  assertEquals(attempts, 2);
});
