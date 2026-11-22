import { test } from "bun:test";
import { readFileSync } from "node:fs";
import { assertEquals } from "@std/assert";
import { SHELL_ACTIONS } from "./shell-actions.ts";

test("the splash only calls actions the page also knows", () => {
  const splash = readFileSync(
    new URL("../../desktop/src-tauri/frontend/splash.js", import.meta.url),
    "utf8",
  );
  const called = new Set<string>();
  for (const match of splash.matchAll(/\$\{BRIDGE\}\/([a-z/-]+)/g)) {
    const action = match[1]!;
    // `${BRIDGE}/window/${action}` builds the name at run time; only the
    // literal calls are comparable here.
    if (action.endsWith("/")) continue;
    called.add(action);
  }
  const known = new Set<string>(SHELL_ACTIONS);
  for (const action of called) {
    assertEquals(known.has(action), true, action);
  }
  // The splash's three roads are in the list (a sanity check on the parser).
  assertEquals(called.has("state"), true);
  assertEquals(called.has("connect-saved"), true);
  assertEquals(called.has("connect-local"), true);
});
