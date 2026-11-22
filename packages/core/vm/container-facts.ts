/**
 * What one `podman container inspect` answers about a machine, and the two
 * judgements that read it: which host port the screen was published on, and
 * whether the container's cgroup carries the ceilings this installation asks
 * for.
 *
 * One inspect, parsed here: every `podman` call is a process spawn and the
 * client polls the status while it watches stella mode, so the state, the
 * instance, the published port, the ceilings and the agent label are asked in
 * one call and read from one answer.
 */

import type { VmCommandRunner } from "./command.ts";
import {
  VM_AGENT_LABEL,
  VM_MEMORY_LIMIT_BYTES,
  VM_MEMORY_SWAP_BYTES,
  VM_PIDS_LIMIT,
  VM_VNC_PORT,
} from "./contract.ts";
import { podman } from "./podman.ts";

/**
 * One `podman container inspect` answer, in the fields the state is decided
 * from.
 *
 * Tab-separated and parsed here rather than asked as one template per field:
 * every `podman` call is a process spawn, and the client polls this status
 * while it watches stella mode. The port mapping and the labels are JSON
 * because podman's Go template exposes them as maps whose fields differ
 * between versions, while the JSON is the same in all of them.
 *
 * `{{.Id}}` and `{{.State.StartedAt}}` together name one INSTANCE of the
 * machine: the contract check is made once per instance, so a stop and start
 * (or a recreation) is verified again and a running one is not asked again on
 * every poll.
 */
const CONTAINER_FACTS_FORMAT = `{{.Id}}\t{{.State.Status}}\t{{.State.StartedAt}}\t{{json .NetworkSettings.Ports}}\t{{.HostConfig.Memory}}\t{{.HostConfig.MemorySwap}}\t{{.HostConfig.PidsLimit}}\t{{json .Config.Labels}}`;

/** What one inspect answered about the container. */
export interface ContainerFacts {
  /** The container's own id and when its current run began: together they
   * name the instance whose contract was verified. */
  id: string;
  startedAt: string;
  /** `podman`'s status word; `running` is the only one the machine can serve
   * calls in. */
  status: string;
  /** The host ports the machine publishes, by container port. */
  ports: Record<string, unknown>;
  /** The screen's host port, when there is one. */
  vncPort: number | null;
  /** The agent the container was created for (VM_AGENT_LABEL), or "" when the
   * label is missing. Compared with the agent whose machine asked, so a
   * container reused by hand is replaced rather than driven as somebody
   * else's. */
  agent: string;
  /** The ceilings the container was created with, as podman printed them: two
   * byte counts and a process count. Strings because the answer is compared
   * with what contract.ts asks for and printed back when it differs — a
   * container created without them reports `0`, and a version of podman that
   * answers something else must be reported rather than turned into NaN. */
  memory: string;
  memorySwap: string;
  pidsLimit: string;
}

/** The published host port of the machine's screen, out of the inspect
 * answer's port mapping (`{"6080/tcp":[{"HostIp":"127.0.0.1",
 * "HostPort":"35483"}]}`). */
function vncPortOf(ports: Record<string, unknown>): number | null {
  const bindings = ports[`${VM_VNC_PORT}/tcp`];
  if (!Array.isArray(bindings)) return null;
  for (const binding of bindings) {
    if (typeof binding !== "object" || binding === null) continue;
    const port = Number((binding as { HostPort?: unknown }).HostPort);
    if (Number.isInteger(port) && port > 0) return port;
  }
  return null;
}

/** The sentence a machine whose cgroup has no ceilings contributes, or null
 * when it has the ones contract.ts asks for.
 *
 * A container created without the ceilings is not the machine this
 * installation describes: it would run the same tools with nothing bounding a
 * runaway process, which is the failure they exist to prevent. Reporting it
 * as drift is enough — `start()` replaces such a container, and the agent's
 * home is on its volume, so nothing of the agent's work is lost by that.
 */
export function limitsMismatch(facts: ContainerFacts): string | null {
  if (facts.memory !== String(VM_MEMORY_LIMIT_BYTES)) {
    return (
      `the machine's memory ceiling is ${facts.memory} bytes, expected ` +
      `${VM_MEMORY_LIMIT_BYTES}`
    );
  }
  if (facts.memorySwap !== String(VM_MEMORY_SWAP_BYTES)) {
    return (
      `the machine's swap ceiling is ${facts.memorySwap} bytes, expected ` +
      `${VM_MEMORY_SWAP_BYTES}`
    );
  }
  if (facts.pidsLimit !== String(VM_PIDS_LIMIT)) {
    return (
      `the machine's process ceiling is ${facts.pidsLimit}, expected ` +
      `${VM_PIDS_LIMIT}`
    );
  }
  return null;
}

export async function readContainerFacts(
  run: VmCommandRunner,
  name: string,
): Promise<ContainerFacts | undefined> {
  const result = await run(
    podman(["container", "inspect", "--format", CONTAINER_FACTS_FORMAT, name]),
    { timeoutMs: 30_000, maxOutput: 8192 },
  );
  if (result.exitCode !== 0) return undefined;
  const line = result.stdout.trim().split("\n")[0] ?? "";
  const [id, status, startedAt, ports, memory, memorySwap, pidsLimit, labels] =
    line.split("\t");
  if (id === undefined || status === undefined) return undefined;
  let published: Record<string, unknown> = {};
  try {
    published = JSON.parse(ports ?? "{}") as Record<string, unknown>;
  } catch {
    // An answer without a readable mapping is a machine whose screen cannot
    // be reached; the status is still worth reporting.
  }
  let named: Record<string, unknown> = {};
  try {
    named = JSON.parse(labels ?? "{}") as Record<string, unknown>;
  } catch {
    // An answer without readable labels is a container whose owner cannot be
    // proven; the caller replaces it.
  }
  const agent = named[VM_AGENT_LABEL];
  return {
    id,
    startedAt: startedAt ?? "",
    status,
    ports: published,
    vncPort: vncPortOf(published),
    agent: typeof agent === "string" ? agent : "",
    memory: memory ?? "",
    memorySwap: memorySwap ?? "",
    pidsLimit: pidsLimit ?? "",
  };
}
