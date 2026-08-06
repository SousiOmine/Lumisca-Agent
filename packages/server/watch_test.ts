import { join } from "node:path";
import { assertEquals } from "jsr:@std/assert";
import { SourceWatcher } from "./watch.ts";

Deno.test("SourceWatcher fires on source file changes", async () => {
  const dir = await Deno.makeTempDir({ prefix: "lumisca-watch-" });
  const watcher = new SourceWatcher(dir);
  let fired = 0;
  await watcher.start(() => fired++);

  // Create a .ts file: should trigger (possibly more than once; debounced).
  const file = join(dir, "hello.ts");
  await Deno.writeTextFile(file, "export const a = 1;");
  await delay(600);
  assertEquals(fired, 1, "create burst should fire once after debounce");

  // Modify it: should trigger again.
  await Deno.writeTextFile(file, "export const a = 2;");
  await delay(600);
  assertEquals(fired, 2, "modify should fire again");

  // Unrelated files: must not trigger.
  await Deno.writeTextFile(join(dir, "notes.md"), "hello");
  await Deno.writeTextFile(join(dir, "data.json"), "{}");
  await delay(600);
  assertEquals(fired, 2, "non ts/tsx/css files must not fire");

  watcher.stop();
  await Deno.remove(dir, { recursive: true });
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
