import { assert, assertEquals } from "@std/assert";
import { confirmAction } from "./confirm.ts";

/** Repository-relative path of the web sources (this file is src/<name>). */
const SRC = new URL("./", import.meta.url);

Deno.test("confirmAction asks the browser and answers its result", () => {
  const globals = globalThis as unknown as { confirm: unknown };
  const original = globals.confirm;
  const asked: string[] = [];
  globals.confirm = (message: string) => {
    asked.push(message);
    return true;
  };
  try {
    assertEquals(confirmAction("Delete it?"), true);
    assertEquals(asked, ["Delete it?"]);
  } finally {
    globals.confirm = original;
  }
});

Deno.test("confirm.ts is the only place that calls the browser dialog", async () => {
  // The module exists so the wording cannot drift: a panel calling
  // `confirm(...)` directly skipped the catalogue and the shared shape.
  const offenders: string[] = [];
  for await (const path of sourceFiles(SRC)) {
    if (path === "confirm.ts") continue;
    const text = await Deno.readTextFile(new URL(path, SRC));
    // `confirmAction(` is the allowed spelling; a bare `confirm(` is not.
    if (/(?<![\w.])confirm\(/.test(text)) offenders.push(path);
  }
  assertEquals(
    offenders,
    [],
    `use confirmAction from confirm.ts instead of the browser dialog: ${
      offenders.join(", ")
    }`,
  );
});

Deno.test("confirm: every catalogue delete confirmation goes through it", async () => {
  let found = 0;
  for await (const path of sourceFiles(SRC)) {
    const text = await Deno.readTextFile(new URL(path, SRC));
    if (text.includes("confirmAction(")) found++;
  }
  assert(found > 3, `only ${found} call sites were found`);
});

async function* sourceFiles(dir: URL, prefix = ""): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    if (entry.isDirectory) {
      yield* sourceFiles(
        new URL(`${entry.name}/`, dir),
        `${prefix}${entry.name}/`,
      );
    } else if (
      (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) &&
      !entry.name.includes("_test.")
    ) {
      yield `${prefix}${entry.name}`;
    }
  }
}
