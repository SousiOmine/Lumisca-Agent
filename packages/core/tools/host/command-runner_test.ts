import { join } from "node:path";
import { realpathSync } from "node:fs";
import { assertEquals } from "@std/assert";
import { HostCommandRunner } from "./command-runner.ts";
import { removeDirRetry } from "../../test-utils.ts";

/** A temp workspace both shells can read (`cat` is a real binary on POSIX
 * and a Get-Content alias in PowerShell), resolved so macOS's /var symlink
 * does not change the path under the runner. */
function workspace(): string {
  return realpathSync(Deno.makeTempDirSync({ prefix: "lumisca-runner-" }));
}

Deno.test("command runner: a capped stream keeps its tail, not its head", async () => {
  const root = workspace();
  try {
    await Deno.writeTextFile(
      join(root, "big.txt"),
      `START-OF-OUTPUT\n${"filler line\n".repeat(50_000)}END-OF-OUTPUT\n`,
    );
    const result = await new HostCommandRunner().run("cat big.txt", {
      cwd: root,
      timeoutSec: 30,
      // Far below the ~600 KB the file holds: the runner must cut it.
      maxOutputChars: 64,
    });
    assertEquals(result.stdoutTruncated, true);
    assertEquals(result.stdout.length <= 64, true);
    assertEquals(result.stdout.includes("START-OF-OUTPUT"), false);
    assertEquals(result.stdout.includes("END-OF-OUTPUT"), true);
    assertEquals(result.stderrTruncated, false);
  } finally {
    await removeDirRetry(root);
  }
});

Deno.test("command runner: a stream under the cap is returned whole", async () => {
  const root = workspace();
  try {
    await Deno.writeTextFile(join(root, "small.txt"), "small output\n");
    const result = await new HostCommandRunner().run("cat small.txt", {
      cwd: root,
      timeoutSec: 30,
      maxOutputChars: 1024,
    });
    assertEquals(result.stdoutTruncated, false);
    assertEquals(result.stdout.trim(), "small output");
  } finally {
    await removeDirRetry(root);
  }
});
