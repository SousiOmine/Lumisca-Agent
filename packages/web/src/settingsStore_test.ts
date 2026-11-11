import { assert, assertEquals } from "@std/assert";
import { settingsStore } from "./settingsStore.ts";

/** Replace `fetch` for the duration of `call`, answering every settings
 * request from `respond`. */
async function withFetch(
  respond: (init?: RequestInit) => Response,
  call: () => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
    void input;
    return Promise.resolve(respond(init));
  };
  try {
    await call();
  } finally {
    globalThis.fetch = original;
  }
}

const ok = (body: Record<string, string>) => () =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

Deno.test("settings store: two subscribers opening together share one read", async () => {
  settingsStore.reset();
  let reads = 0;
  await withFetch(
    () => {
      reads++;
      return new Response(JSON.stringify({ theme: "dark" }), { status: 200 });
    },
    async () => {
      // Two screens mounting in the same tick (the tab-switch case) reuse the
      // read already in flight instead of asking the server twice.
      const unsubscribe = [
        settingsStore.subscribe(() => {}),
        settingsStore.subscribe(() => {}),
      ];
      await settingsStore.reload();
      for (const off of unsubscribe) off();
    },
  );
  assertEquals(reads, 1, "the shared read is issued once");
  assertEquals(settingsStore.value("theme"), "dark");
});

Deno.test("settings store: the newer read wins", async () => {
  settingsStore.reset();
  let call = 0;
  await withFetch(
    () => {
      call++;
      if (call === 1) {
        // The first read is held until the second has answered, so its stale
        // value would land last if the store published whatever came back.
        return new Response(JSON.stringify({ theme: "old" }), { status: 200 });
      }
      return new Response(JSON.stringify({ theme: "new" }), { status: 200 });
    },
    async () => {
      const slow = settingsStore.reload();
      await settingsStore.reload();
      await slow;
    },
  );
  assertEquals(settingsStore.value("theme"), "new");
});

Deno.test("settings store: a failed read keeps the values and reports it", async () => {
  settingsStore.reset();
  await withFetch(ok({ theme: "dark" }), () => settingsStore.reload());
  await withFetch(
    () => new Response("{}", { status: 500 }),
    () => settingsStore.reload(),
  );
  assertEquals(settingsStore.get().loaded, true);
  assertEquals(settingsStore.get().error !== null, true);
  assertEquals(settingsStore.value("theme"), "dark", "the values survive");
});

Deno.test("settings store: a write is reflected and rolled back on failure", async () => {
  settingsStore.reset();
  await withFetch(ok({ theme: "dark" }), () => settingsStore.reload());

  // A successful write lands locally.
  await withFetch(ok({}), () => settingsStore.set("language", "ja"));
  assertEquals(settingsStore.value("language"), "ja");

  // A rejected one restores what was there (and removes a key that was new).
  await withFetch(
    () => new Response("{}", { status: 403 }),
    async () => {
      let failed = false;
      try {
        await settingsStore.set("language", "en");
      } catch {
        failed = true;
      }
      assert(failed, "the write must fail");
    },
  );
  assertEquals(settingsStore.value("language"), "ja");

  await withFetch(
    () => new Response("{}", { status: 403 }),
    async () => {
      try {
        await settingsStore.set("brand_new", "x");
      } catch {
        // expected
      }
    },
  );
  assertEquals(settingsStore.value("brand_new"), undefined);
});
