import { assertEquals } from "@std/assert";
import { killProcessTree } from "./process-tree.ts";
import { shellCommand } from "./shell.ts";
import { removeDirRetry, waitUntil } from "../test-utils.ts";

/**
 * `killProcessTree` stops the tree a command grew, not only the shell the
 * caller holds. The POSIX sweep exists because a signal to the shell alone
 * left everything the command spawned running — the shape of a real
 * incident: `async_bash_kill` reported "Killed background command #3."
 * while the killed command's own servers kept running and holding their
 * pipes.
 *
 * The command syntax below (`&`, `while :`) is /bin/sh's, so the tree tests
 * run on POSIX only. The Windows walk is a different implementation and is
 * unaffected by the reparenting the POSIX sweep has to work around.
 */

Deno.test({
  name: "killProcessTree kills every descendant, not only the shell",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const root = Deno.makeTempDirSync({ prefix: "lumisca-tree-" });
    const marker = "marker";
    try {
      // The shell backgrounds a child that keeps writing and then waits: a
      // kill that reached only the shell would leave that child appending
      // (and holding the shell's pipes, which is what made a killed
      // command's output look alive).
      const child = shellCommand({
        command:
          `sh -c 'while :; do echo tick >> ${marker}; sleep 0.2; done' & wait`,
        cwd: root,
      }).spawn();
      await waitUntil(
        () => {
          try {
            return Deno.statSync(`${root}/${marker}`).size > 0;
          } catch {
            return false;
          }
        },
        "the command's child to write its first tick",
      );

      await killProcessTree(child);

      // A survivor (or a zombie) cannot append: let any write already in
      // flight land, then require the file to stay exactly this size for
      // longer than the writer's interval.
      await new Promise((resolve) => setTimeout(resolve, 300));
      const size = Deno.statSync(`${root}/${marker}`).size;
      await new Promise((resolve) => setTimeout(resolve, 600));
      assertEquals(
        Deno.statSync(`${root}/${marker}`).size,
        size,
        "the command's own process is still writing: the kill reached only the shell",
      );
      // The shell is gone as well: its `wait` returns once its child dies,
      // so its own exit code is not pinned here — the sweep is what killed
      // the tree (and the file above is what proves it reached the child).
      await child.status;
    } finally {
      await removeDirRetry(root);
    }
  },
});

Deno.test("killProcessTree is a no-op once the process is gone", async () => {
  const child = shellCommand({ command: "exit 0", cwd: Deno.cwd() }).spawn();
  await child.status;
  // Must not throw: callers kill after a command may have exited on its own.
  await killProcessTree(child);
});
