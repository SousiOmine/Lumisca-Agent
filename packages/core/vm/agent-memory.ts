/**
 * MEMORY.md: the file a stella agent keeps its own notes in, inside its
 * working folder.
 *
 * A file rather than a column the way `identity` is (stella/identity.ts),
 * because the agent decides what to load and when: the system prompt states
 * the convention, the ordinary file tools do the reading and writing, and
 * nothing is published into every request. It is also something the user can
 * open in the machine's own file manager.
 */
import type { VmExec } from "./container.ts";
import { vmAgentDir } from "./contract.ts";

/** The file's name, inside the agent's working folder. */
export const AGENT_MEMORY_FILE = "MEMORY.md";

/** Where one agent's notes are (absolute, inside the machine). */
export function vmMemoryPath(agentId: string): string {
  return `${vmAgentDir(agentId)}/${AGENT_MEMORY_FILE}`;
}

/** Create the agent's working folder and leave an empty MEMORY.md in it when
 * there is none.
 *
 * One `podman exec` for both: creating an agent waits for this, and the
 * folder has to exist before the file can be written. The file is created
 * only when it is missing — an unconditional `: >` would empty the notes the
 * agent wrote last time, and every open of a conversation runs this again.
 *
 * The exit code is not inspected: a machine that refuses the folder already
 * fails the session's own tools, and opening a conversation is not the place
 * to report it. */
export async function ensureAgentMemory(
  exec: VmExec,
  agentId: string,
): Promise<void> {
  await exec([
    "sh",
    "-c",
    'mkdir -p -- "$1" && { [ -e "$2" ] || : > "$2"; }',
    "sh",
    vmAgentDir(agentId),
    vmMemoryPath(agentId),
  ], { timeoutMs: 30_000 });
}
