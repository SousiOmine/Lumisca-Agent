import { test } from "bun:test";
import { assertEquals } from "@std/assert";
import { runProcess } from "./process.ts";

/** The child prints one variable, so the test can tell which environment it
 * was handed. */
const probe = "console.log(process.env.LUMISCA_PROBE ?? 'unset')";

test("runProcess inherits the parent environment", async () => {
  process.env["LUMISCA_PROBE"] = "inherited";
  try {
    const result = await runProcess([process.execPath, "-e", probe]);
    assertEquals(new TextDecoder().decode(result.stdout).trim(), "inherited");
    assertEquals(result.success, true);
  } finally {
    delete process.env["LUMISCA_PROBE"];
  }
});

test("runProcess drops the parent env when env is empty", async () => {
  process.env["LUMISCA_PROBE"] = "inherited";
  try {
    const result = await runProcess([process.execPath, "-e", probe], {
      env: {},
    });
    assertEquals(new TextDecoder().decode(result.stdout).trim(), "unset");
  } finally {
    delete process.env["LUMISCA_PROBE"];
  }
});

test("runProcess hands over an explicit environment", async () => {
  process.env["LUMISCA_PROBE"] = "inherited";
  try {
    const result = await runProcess([process.execPath, "-e", probe], {
      env: { LUMISCA_PROBE: "explicit" },
    });
    assertEquals(new TextDecoder().decode(result.stdout).trim(), "explicit");
  } finally {
    delete process.env["LUMISCA_PROBE"];
  }
});
