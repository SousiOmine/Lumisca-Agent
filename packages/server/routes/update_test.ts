import { assertEquals } from "@std/assert";
import { fauxProvider, LumiscaCore } from "@lumisca/core";
import { createApp } from "../app.ts";
import type { UpdateStatus } from "../update/service.ts";
import { type UpdateApi, updateRoutes } from "./update.ts";

function status(overrides: Partial<UpdateStatus> = {}): UpdateStatus {
  return {
    supported: true,
    unsupportedReason: null,
    currentVersion: "0.7.7",
    target: "x86_64-unknown-linux-gnu",
    autoUpdate: true,
    autoRestart: false,
    restartMode: "self",
    checking: false,
    available: false,
    latestVersion: null,
    downloading: false,
    progress: null,
    downloaded: null,
    total: null,
    ready: false,
    applied: false,
    appliedVersion: null,
    restartPending: false,
    restarting: false,
    error: null,
    ...overrides,
  };
}

function fakeApi(): { api: UpdateApi; calls: string[] } {
  const calls: string[] = [];
  const api: UpdateApi = {
    status: () => status({ error: calls.join(",") || null }),
    setAuto: (enabled) => {
      calls.push(`set-auto:${enabled}`);
      return status({ autoUpdate: enabled });
    },
    setAutoRestart: (enabled) => {
      calls.push(`set-auto-restart:${enabled}`);
      return status({ autoRestart: enabled });
    },
    check: () => {
      calls.push("check");
      return Promise.resolve(
        status({ available: true, latestVersion: "0.7.8" }),
      );
    },
    download: () => {
      calls.push("download");
      return Promise.resolve(status({ ready: true }));
    },
    apply: () => {
      calls.push("install");
      return Promise.resolve(status({ applied: true, restartPending: true }));
    },
    restart: () => {
      calls.push("restart");
      return Promise.resolve(status({ restarting: true }));
    },
  };
  return { api, calls };
}

function hostHeaders(): HeadersInit {
  // createApp's Host guard needs a loopback Host header; `new Request`
  // does not add one.
  return { host: "127.0.0.1:8000", "content-type": "application/json" };
}

Deno.test("update endpoints drive the updater and answer with its status", async () => {
  const core = LumiscaCore.forTesting([fauxProvider().provider]);
  const { api, calls } = fakeApi();
  const app = createApp(core, { update: api });
  const post = (path: string, body?: unknown) =>
    app.fetch(
      new Request(`http://127.0.0.1:8000${path}`, {
        method: "POST",
        headers: hostHeaders(),
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  try {
    const initial = await app.fetch(
      new Request("http://127.0.0.1:8000/api/update/status", {
        headers: hostHeaders(),
      }),
    );
    assertEquals(initial.status, 200);
    const initialBody = await initial.json() as UpdateStatus;
    assertEquals(initialBody.currentVersion, "0.7.7");
    assertEquals(initialBody.supported, true);
    assertEquals(initialBody.autoUpdate, true);

    const auto = await post("/api/update/set-auto", { enabled: false });
    assertEquals(auto.status, 200);
    assertEquals((await auto.json() as UpdateStatus).autoUpdate, false);
    const autoRestart = await post("/api/update/set-auto-restart", {
      enabled: true,
    });
    assertEquals((await autoRestart.json() as UpdateStatus).autoRestart, true);

    // Every action returns the state it produced, so the UI can update
    // without waiting for its next poll.
    const checked = await post("/api/update/check");
    assertEquals((await checked.json() as UpdateStatus).latestVersion, "0.7.8");
    assertEquals(
      (await (await post("/api/update/download")).json() as UpdateStatus).ready,
      true,
    );
    assertEquals(
      (await (await post("/api/update/install")).json() as UpdateStatus)
        .applied,
      true,
    );
    assertEquals(
      (await (await post("/api/update/restart")).json() as UpdateStatus)
        .restarting,
      true,
    );

    assertEquals(calls, [
      "set-auto:false",
      "set-auto-restart:true",
      "check",
      "download",
      "install",
      "restart",
    ]);
  } finally {
    core.close();
  }
});

Deno.test("update endpoints reject malformed bodies with 400", async () => {
  const core = LumiscaCore.forTesting([fauxProvider().provider]);
  const { api, calls } = fakeApi();
  const app = createApp(core, { update: api });
  try {
    for (const body of ["{}", `{"enabled":"yes"}`, "not json"]) {
      const res = await app.fetch(
        new Request("http://127.0.0.1:8000/api/update/set-auto", {
          method: "POST",
          headers: hostHeaders(),
          body,
        }),
      );
      assertEquals(res.status, 400, `body ${body} must be refused`);
    }
    assertEquals(calls, [], "a refused body never reaches the updater");
  } finally {
    core.close();
  }
});

Deno.test("without an updater the endpoints are absent, not empty", async () => {
  const core = LumiscaCore.forTesting([fauxProvider().provider]);
  const app = createApp(core);
  try {
    // Development runs have no updater: the UI must be able to tell that
    // apart from "no update available".
    const res = await app.fetch(
      new Request("http://127.0.0.1:8000/api/update/status", {
        headers: hostHeaders(),
      }),
    );
    assertEquals(res.status, 404);
    assertEquals((await res.json()).error, "Not found");
  } finally {
    core.close();
  }
});

Deno.test("the routes module can be mounted on its own", async () => {
  // updateRoutes is a plain Hono app (the shape every route module in this
  // package has), so it can be exercised without the whole server.
  const { api, calls } = fakeApi();
  const app = updateRoutes(api);
  const res = await app.fetch(
    new Request("http://127.0.0.1:8000/update/check", { method: "POST" }),
  );
  assertEquals(res.status, 200);
  assertEquals(calls, ["check"]);
});
