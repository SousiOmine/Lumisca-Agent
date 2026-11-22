import { test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PromptFileRef, SessionInfo } from "@lumisca/core";
import { MAX_PROMPT_FILE_BYTES } from "@lumisca/core/shared";
import { assertEquals, assertThrows } from "@std/assert";
import {
  type PromptUploadApi,
  PromptUploads,
  promptUploadRoutes,
} from "./prompt-uploads.ts";
import { AppError, jsonError } from "./util.ts";

interface Copied {
  sessionId: string;
  name: string;
  path: string;
  size: number;
}

function fakeCore(copied: Copied[]): PromptUploadApi {
  return {
    getStellaAgent: () => ({ disabledAt: null }),
    ensureStellaReady: () => Promise.resolve(),
    getOrCreateStellaSession: () =>
      Promise.resolve({ id: "s1" } as SessionInfo),
    savePromptFile: (sessionId, file) => {
      copied.push({ sessionId, ...file });
      const saved: PromptFileRef = {
        name: file.name,
        path: `/home/agent/agents/a1/uploads/1-ab/01-${file.name}`,
        size: file.size,
        ref: `uploads/1-ab/01-${file.name}`,
        image: false,
      };
      return Promise.resolve(saved);
    },
  };
}

async function makeStore(
  options: { copied?: Copied[]; retentionMs?: number } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "lumisca-uploads-"));
  const copied = options.copied ?? [];
  const store = new PromptUploads({
    dir,
    core: fakeCore(copied),
    retentionMs: options.retentionMs ?? 60_000,
    cleanupIntervalMs: 60_000,
  });
  const app = promptUploadRoutes(store);
  app.onError((error, c) => jsonError(c, error));
  return { dir, store, app, copied };
}

function chunkHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

test("prompt uploads: a file is chunked, copied once, and readable by its ref", async () => {
  const { dir, store, app, copied } = await makeStore();
  const created = await app.request("/stella/conversations/a1/uploads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "run.log", size: 10 }),
  });
  assertEquals(created.status, 200);
  const { id } = (await created.json()) as { id: string };
  const first = new TextEncoder().encode("hello");
  const second = new TextEncoder().encode("world");
  for (const [offset, bytes] of [
    [0, first],
    [5, second],
  ] as const) {
    const response = await app.request(
      `/stella/conversations/a1/uploads/${id}?offset=${offset}`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/octet-stream",
          "x-chunk-sha256": chunkHash(bytes),
        },
        body: bytes as unknown as BodyInit,
      },
    );
    assertEquals(response.status, 200);
  }
  const complete = await app.request(
    `/stella/conversations/a1/uploads/${id}/complete`,
    { method: "POST" },
  );
  assertEquals(complete.status, 200);
  // The copy is a background job: poll the status the way the browser does.
  let saved: PromptFileRef | undefined;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const state = await app.request(`/stella/conversations/a1/uploads/${id}`);
    const body = (await state.json()) as {
      status: string;
      saved?: PromptFileRef;
    };
    if (body.status === "completed") {
      saved = body.saved;
      break;
    }
    await Bun.sleep(5);
  }
  assertEquals(saved?.ref, "uploads/1-ab/01-run.log");
  assertEquals(copied.length, 1);
  assertEquals(copied[0]!.size, 10);
  assertEquals(store.resolve("a1", [id]).length, 1);
  store.release([id]);
  assertEquals(await readdir(dir), []);
  store.dispose();
  await rm(dir, { recursive: true, force: true });
});

test("prompt uploads: an offset that is not the end is refused", async () => {
  const { dir, store, app } = await makeStore();
  const created = await app.request("/stella/conversations/a1/uploads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "a.txt", size: 5 }),
  });
  const { id } = (await created.json()) as { id: string };
  const bytes = new TextEncoder().encode("hello");
  const response = await app.request(
    `/stella/conversations/a1/uploads/${id}?offset=2`,
    {
      method: "PUT",
      headers: { "x-chunk-sha256": chunkHash(bytes) },
      body: bytes as unknown as BodyInit,
    },
  );
  assertEquals(response.status, 409);
  store.dispose();
  await rm(dir, { recursive: true, force: true });
});

test("prompt uploads: a chunk whose hash does not match is refused", async () => {
  const { dir, store, app } = await makeStore();
  const created = await app.request("/stella/conversations/a1/uploads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "a.txt", size: 5 }),
  });
  const { id } = (await created.json()) as { id: string };
  const bytes = new TextEncoder().encode("hello");
  const response = await app.request(
    `/stella/conversations/a1/uploads/${id}?offset=0`,
    {
      method: "PUT",
      headers: { "x-chunk-sha256": "0".repeat(64) },
      body: bytes as unknown as BodyInit,
    },
  );
  assertEquals(response.status, 400);
  store.dispose();
  await rm(dir, { recursive: true, force: true });
});

test("prompt uploads: a file over the per-file bound is refused", async () => {
  const { dir, store, app } = await makeStore();
  const created = await app.request("/stella/conversations/a1/uploads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "big.bin", size: MAX_PROMPT_FILE_BYTES + 1 }),
  });
  assertEquals(created.status, 400);
  store.dispose();
  await rm(dir, { recursive: true, force: true });
});

test("prompt uploads: two appends at one offset cannot both write", async () => {
  const { dir, store } = await makeStore();
  const created = await store.create("a1", "a.txt", 5);
  const bytes = new TextEncoder().encode("hello");
  const results = await Promise.allSettled([
    store.append("a1", created.id, 0, bytes, chunkHash(bytes)),
    store.append("a1", created.id, 0, bytes, chunkHash(bytes)),
  ]);
  assertEquals(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assertEquals(store.status("a1", created.id).bytes, 5);
  store.dispose();
  await rm(dir, { recursive: true, force: true });
});

test("prompt uploads: an unknown id is not a file the prompt can name", async () => {
  const { dir, store } = await makeStore();
  const error = assertThrows(() => store.resolve("a1", ["missing"]), AppError);
  assertEquals((error as AppError).status, 409);
  store.dispose();
  await rm(dir, { recursive: true, force: true });
});

test("prompt uploads: cancel removes the partial file", async () => {
  const { dir, store, app } = await makeStore();
  const created = await app.request("/stella/conversations/a1/uploads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "a.txt", size: 5 }),
  });
  const { id } = (await created.json()) as { id: string };
  assertEquals((await readdir(dir)).length, 1);
  const response = await app.request(`/stella/conversations/a1/uploads/${id}`, {
    method: "DELETE",
  });
  assertEquals(response.status, 200);
  assertEquals(await readdir(dir), []);
  store.dispose();
  await rm(dir, { recursive: true, force: true });
});
