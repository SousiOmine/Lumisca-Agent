import { assert, assertEquals } from "@std/assert";
import {
  AGENT_MEMORY_FILE,
  ensureAgentMemory,
  vmMemoryPath,
} from "./agent-memory.ts";
import { vmAgentDir } from "./contract.ts";
import { buildStellaSystemPrompt } from "../tools/system-prompt.ts";
import type { VmExec } from "./container.ts";

/**
 * MEMORY.md is made by ONE shell command, and the shape of that command is the
 * whole contract: the folder, and a file created only when it is missing. A
 * test of "it ran mkdir" would not notice the day the guard is dropped, and
 * the guard is what keeps an agent's notes from being emptied every time its
 * conversation opens.
 */

const AGENT = "agent-1";

/** An exec seam that records what crossed it and answers success. */
function recording(): { exec: VmExec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: VmExec = (command: readonly string[]) => {
    calls.push([...command]);
    return Promise.resolve({
      exitCode: 0,
      stdout: "",
      stderr: "",
      truncated: false,
      timedOut: false,
    });
  };
  return { exec, calls };
}

Deno.test("vm memory: the folder and MEMORY.md are one command", async () => {
  const { exec, calls } = recording();
  await ensureAgentMemory(exec, AGENT);

  assertEquals(calls.length, 1);
  const [command] = calls;
  assert(command !== undefined);
  assertEquals(command.slice(0, 2), ["sh", "-c"]);
  // The paths travel as arguments, never inside the script: an agent id that
  // contained shell syntax would still be a path.
  assertEquals(command.slice(3), [
    "sh",
    vmAgentDir(AGENT),
    vmMemoryPath(AGENT),
  ]);
  assertEquals(
    vmMemoryPath(AGENT),
    `${vmAgentDir(AGENT)}/${AGENT_MEMORY_FILE}`,
  );
});

Deno.test("vm memory: an existing MEMORY.md is never emptied", async () => {
  const { exec, calls } = recording();
  await ensureAgentMemory(exec, AGENT);
  const [command] = calls;
  assert(command !== undefined);
  // Pinned exactly: opening a conversation runs this again, so an unguarded
  // `: >` would throw away what the agent wrote last time.
  assertEquals(
    command[2],
    'mkdir -p -- "$1" && { [ -e "$2" ] || : > "$2"; }',
  );
});

Deno.test("vm memory: the prompt names the file the machine creates", () => {
  // The prompt is written by hand and the file by the machine; a rename on one
  // side alone would leave the agent told about a file nobody makes.
  const prompt = buildStellaSystemPrompt({
    agent: { role: "r" },
    workdir: vmAgentDir(AGENT),
  });
  assert(prompt.includes(AGENT_MEMORY_FILE), prompt);
});
