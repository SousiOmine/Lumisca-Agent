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

Deno.test("settings store: one read serves every subscriber", async () => {
  settingsStore.reset();
  let reads = 0;
  await withFetch(() => {
    reads++;
    return new Response(JSON.stringify({ theme: "dark" }), { status: 200 });
  }, async () => {
    // Two subscribers, two reads in flight: the second waits for the first
    // instead of hitting the endpoint again (the tab-switch case).
    const first = settingsStore.reload();
    const second = settingsStore.reload();
    await Promise.all([first, second]);
    await settingsStore.reload();
  });
  assertEquals(reads, 2, "a concurrent read is shared, a later one is not");
  assertEquals(settingsStore.value("theme"), "dark");
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
  await withFetch(() => new Response("{}", { status: 403 }), async () => {
    let failed = false;
    try {
      await settingsStore.set("language", "en");
    } catch {
      failed = true;
    }
    assert(failed, "the write must fail");
  });
  assertEquals(settingsStore.value("language"), "ja");

  await withFetch(() => new Response("{}", { status: 403 }), async () => {
    try {
      await settingsStore.set("brand_new", "x");
    } catch {
      // expected
    }
  });
  assertEquals(settingsStore.value("brand_new"), undefined);
});
