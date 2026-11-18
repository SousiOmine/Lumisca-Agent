import { test } from "bun:test";
import * as fsSync from "node:fs";
import { realpathSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { tmpdir as osTmpdir } from "node:os";
import { join, join as pathJoin } from "node:path";
import { assertEquals } from "@std/assert";
import { removeDirRetry } from "../../test-utils.ts";
import { HostCommandRunner } from "./command-runner.ts";

/** A temp workspace both shells can read (`cat` is a real binary on POSIX
 * and a Get-Content alias in PowerShell), resolved so macOS's /var symlink
 * does not change the path under the runner. */
function workspace(): string {
  return realpathSync.native(
    fsSync.mkdtempSync(pathJoin(osTmpdir(), "lumisca-runner-")),
  );
}

test("command runner: a capped stream keeps its tail, not its head", async () => {
  const root = workspace();
  try {
    // ~60 KiB, where this held ~600 KB: the assertion is about which end
    // survives a 64-character cap, and every byte goes through the platform
    // shell to get there (the same 600 KB took 9s on Windows, 0.7s here).
    await fsp.writeFile(
      join(root, "big.txt"),
      `START-OF-OUTPUT\n${"filler line\n".repeat(5_000)}END-OF-OUTPUT\n`,
    );
    const result = await new HostCommandRunner().run("cat big.txt", {
      cwd: root,
      timeoutSec: 30,
      // Far below the ~60 KB the file holds: the runner must cut it.
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

test("command runner: a stream under the cap is returned whole", async () => {
  const root = workspace();
  try {
    await fsp.writeFile(join(root, "small.txt"), "small output\n");
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
