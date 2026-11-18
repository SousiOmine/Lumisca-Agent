import { test } from "bun:test";
import { assertEquals } from "@std/assert";
import { createDebouncedWriter } from "./useSave.ts";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("a debounced writer writes the pending value when disposed", () => {
  const written: string[] = [];
  const writer = createDebouncedWriter<string>((value) => {
    written.push(value);
  }, 60_000);
  writer.schedule("typed");
  writer.dispose();
  assertEquals(written, ["typed"]);
});

test("a disposed writer does not write again", async () => {
  const written: string[] = [];
  const writer = createDebouncedWriter<string>((value) => {
    written.push(value);
  }, 5);
  writer.schedule("typed");
  writer.dispose();
  await wait(20);
  assertEquals(written, ["typed"]);
});

test("cancel drops the pending value", async () => {
  const written: string[] = [];
  const writer = createDebouncedWriter<string>((value) => {
    written.push(value);
  }, 5);
  writer.schedule("typed");
  writer.cancel();
  await wait(20);
  assertEquals(written, []);
});

test("flush writes the pending value immediately", async () => {
  const written: string[] = [];
  const writer = createDebouncedWriter<string>((value) => {
    written.push(value);
  }, 60_000);
  writer.schedule("typed");
  await writer.flush();
  assertEquals(written, ["typed"]);
});

test("the last scheduled value wins", async () => {
  const written: string[] = [];
  const writer = createDebouncedWriter<string>((value) => {
    written.push(value);
  }, 5);
  writer.schedule("first");
  writer.schedule("second");
  await wait(20);
  assertEquals(written, ["second"]);
});

test("the latest write callback is used", () => {
  const written: string[] = [];
  const writer = createDebouncedWriter<string>((value) => {
    written.push(`old:${value}`);
  }, 60_000);
  writer.setWrite((value) => {
    written.push(`new:${value}`);
  });
  writer.schedule("typed");
  writer.dispose();
  assertEquals(written, ["new:typed"]);
});
