import { join } from "node:path";
import { LumiscaCore } from "@lumisca/core";
import { removeDirRetry } from "@lumisca/core/test-utils";
import { assertEquals } from "@std/assert";
import { startServer } from "./app.ts";
import { setup } from "./test-utils.ts";

/** The initial data the page is seeded with, as the script writes it. */
async function initialDataOf(base: string): Promise<string> {
  const res = await fetch(`${base}/assets/initial-data.js`);
  assertEquals(res.status, 200);
  return await res.text();
}

Deno.test("setup API: a new installation owes the setup until it is finished", async () => {
  const dir = await Deno.makeTempDir({ prefix: "lumisca-setup-" });
  const core = LumiscaCore.open(
    join(dir, "lumisca.db"),
    join(dir, "settings.jsonc"),
  );
  const server = startServer(core, 0);
  const base = `http://127.0.0.1:${server.addr.port}`;
  const marker = join(dir, "setup-complete");
  try {
    const before = await fetch(`${base}/api/setup`);
    assertEquals(before.status, 200);
    assertEquals(await before.json(), { completed: false });
    // The page is seeded with the same answer, so the client can send `/` to
    // the wizard before it renders anything.
    assertEquals(
      (await initialDataOf(base)).includes('"setup":{"completed":false}'),
      true,
    );

    const done = await fetch(`${base}/api/setup/complete`, { method: "POST" });
    assertEquals(done.status, 200);
    assertEquals(await done.json(), { completed: true });
    assertEquals(Deno.statSync(marker).isFile, true);

    const after = await fetch(`${base}/api/setup`);
    assertEquals(await after.json(), { completed: true });
    assertEquals(
      (await initialDataOf(base)).includes('"setup":{"completed":true}'),
      true,
    );

    // Finishing twice (two tabs, a reload while the answer was in flight) is
    // the same state, not an error.
    const again = await fetch(`${base}/api/setup/complete`, {
      method: "POST",
    });
    assertEquals(again.status, 200);
    assertEquals(await again.json(), { completed: true });
  } finally {
    server.shutdown();
    await core.close();
    await removeDirRetry(dir);
  }
});

Deno.test("setup API: deleting the marker asks for the setup again, with no restart", async () => {
  const dir = await Deno.makeTempDir({ prefix: "lumisca-setup-" });
  const core = LumiscaCore.open(
    join(dir, "lumisca.db"),
    join(dir, "settings.jsonc"),
  );
  const server = startServer(core, 0);
  const base = `http://127.0.0.1:${server.addr.port}`;
  const marker = join(dir, "setup-complete");
  try {
    await fetch(`${base}/api/setup/complete`, { method: "POST" });
    assertEquals(await (await fetch(`${base}/api/setup`)).json(), {
      completed: true,
    });

    // The documented way back into the wizard: the file is the state, so the
    // same process answers with the new one. There is no API to reset it.
    Deno.removeSync(marker);
    assertEquals(await (await fetch(`${base}/api/setup`)).json(), {
      completed: false,
    });
    assertEquals(
      (await initialDataOf(base)).includes('"setup":{"completed":false}'),
      true,
    );

    const reset = await fetch(`${base}/api/setup`, { method: "DELETE" });
    assertEquals(reset.status, 404);
  } finally {
    server.shutdown();
    await core.close();
    await removeDirRetry(dir);
  }
});

Deno.test("setup API: an in-memory installation owes no setup", async () => {
  // The test harness (and a scratch core) has no settings file, so there is
  // nowhere for the marker to live: the wizard is never owed, which is why
  // the other app tests never meet it.
  const { core, server, base } = await setup();
  try {
    assertEquals(await (await fetch(`${base}/api/setup`)).json(), {
      completed: true,
    });
    assertEquals(
      (await initialDataOf(base)).includes('"setup":{"completed":true}'),
      true,
    );
  } finally {
    server.shutdown();
    await core.close();
  }
});
