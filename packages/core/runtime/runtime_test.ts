import { test } from "bun:test";
import { assertEquals } from "@std/assert";
import { runtime } from "./runtime.ts";

/**
 * `Command.output()` is the path the updater runs a staged binary through
 * (`clearEnv: true`), so it must resolve the program and build the child's
 * environment exactly as `Command.spawn()` does. Before this test they were
 * two implementations and the `clearEnv` flag was dropped by `output()`.
 */
const probe = "console.log(process.env.LUMISCA_PROBE ?? 'unset')";

test("runtime: Command.output inherits the parent environment", async () => {
  process.env["LUMISCA_PROBE"] = "inherited";
  try {
    const result = await new runtime.Command(runtime.execPath(), {
      args: ["-e", probe],
      stdout: "piped",
    }).output();
    assertEquals(new TextDecoder().decode(result.stdout).trim(), "inherited");
    assertEquals(result.success, true);
  } finally {
    delete process.env["LUMISCA_PROBE"];
  }
});

test("runtime: Command.output drops the parent env when clearEnv is set", async () => {
  process.env["LUMISCA_PROBE"] = "inherited";
  try {
    const result = await new runtime.Command(runtime.execPath(), {
      args: ["-e", probe],
      clearEnv: true,
      stdout: "piped",
    }).output();
    assertEquals(new TextDecoder().decode(result.stdout).trim(), "unset");
  } finally {
    delete process.env["LUMISCA_PROBE"];
  }
});

test("runtime: Command.output merges a partial env over the parent", async () => {
  process.env["LUMISCA_PROBE"] = "inherited";
  try {
    const result = await new runtime.Command(runtime.execPath(), {
      args: ["-e", probe],
      env: { LUMISCA_PROBE: "explicit" },
      stdout: "piped",
    }).output();
    assertEquals(new TextDecoder().decode(result.stdout).trim(), "explicit");
  } finally {
    delete process.env["LUMISCA_PROBE"];
  }
});
