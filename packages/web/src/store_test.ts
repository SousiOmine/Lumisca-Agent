import { test } from "bun:test";
import { assertEquals } from "@std/assert";
import { createResourceStore, createStore } from "./store.ts";

test("createStore notifies only when the identity changes", () => {
  const store = createStore({ n: 1 });
  let calls = 0;
  const off = store.subscribe(() => calls++);
  store.set(store.get());
  assertEquals(calls, 0);
  store.set({ n: 2 });
  assertEquals(calls, 1);
  off();
  store.set({ n: 3 });
  assertEquals(calls, 1);
});

test("two subscribers share the one read in flight", async () => {
  let loads = 0;
  const store = createResourceStore({
    initial: { value: 0 },
    load: async () => ({ value: ++loads }),
  });
  const offA = store.subscribe(() => {});
  const offB = store.subscribe(() => {});
  await Promise.resolve();
  assertEquals(loads, 1);
  assertEquals(store.get().value, 1);
  offA();
  offB();
});

test("a write in flight discards the older read", async () => {
  const gate = Promise.withResolvers<{ value: number }>();
  const store = createResourceStore({
    initial: { value: 0 },
    load: () => gate.promise,
  });
  const reading = store.reload();
  store.commit({ value: 7 });
  gate.resolve({ value: 1 });
  await reading;
  assertEquals(store.get().value, 7);
  assertEquals(store.get().loaded, true);
});

test("a newer read supersedes the older one", async () => {
  const first = Promise.withResolvers<{ value: number }>();
  const second = Promise.withResolvers<{ value: number }>();
  let call = 0;
  const store = createResourceStore({
    initial: { value: 0 },
    load: () => (++call === 1 ? first.promise : second.promise),
  });
  const older = store.reload();
  const newer = store.reload();
  second.resolve({ value: 2 });
  await newer;
  first.resolve({ value: 1 });
  await older;
  assertEquals(store.get().value, 2);
  assertEquals(store.get().loading, false);
});

test("reset discards a read that has not settled", async () => {
  const gate = Promise.withResolvers<{ value: number }>();
  const store = createResourceStore({
    initial: { value: 0 },
    load: () => gate.promise,
  });
  const reading = store.reload();
  store.reset();
  gate.resolve({ value: 9 });
  await reading;
  assertEquals(store.get().value, 0);
  assertEquals(store.get().loaded, false);
});
