/**
 * The session's shared MCP attachment.
 *
 * One attachment per session: its server processes serve every agent of the
 * session (the main agent and the sub-agents) and survive agent rebuilds while
 * the merged config is unchanged. A changed config builds a new one and tears
 * down the old processes — and, on the open path, the tool registries too, so
 * no tool of a config that is gone stays searchable.
 *
 * Two paths build attachments, and they differ in what they keep: `open`
 * reuses the attachment while the config is unchanged (and replaces the
 * registries with a new one), while a config or credential change applied to a
 * STREAMING session swaps the attachment in place and leaves the registries
 * alone (the run keeps the tools it started with).
 */

import type { SessionInfo } from "../domain/session.ts";
import type { Workspace } from "../domain/workspace.ts";
import { createLogger } from "../log.ts";
import { McpAttachment } from "../mcp/attachment.ts";
import type { McpConfig } from "../mcp/config.ts";
import type { MachineRunner } from "../mcp/machine.ts";
import { McpManager } from "../mcp/manager.ts";
import { canonicalJson } from "../shared/digest.ts";
import { SessionToolRegistries } from "../tools/registries.ts";
import type { SessionPoolDeps } from "./deps.ts";
import type { SessionRuntime } from "./session-runtime.ts";

/** A workspace's merged MCP config and the errors collected while merging it
 * (see SessionPoolDeps.loadMergedMcp). */
export interface MergedMcp {
  config: McpConfig;
  errors: string[];
  /** Names of the servers that came from the agent's own config, which run
   * inside its machine. Absent for a session without a machine. */
  machineServers?: ReadonlySet<string>;
}

/** Module logger (debug-gated): attachment rebuilds are the first thing to
 * check when MCP tools misbehave. */
const log = createLogger("pool");

/** True when two merged configs describe the same servers, comparing their
 * canonical (key-sorted) JSON so a settings round-trip that reorders fields
 * does not spuriously tear down and respawn MCP server processes. */
export function sameMcpConfig(a: McpConfig, b: McpConfig): boolean {
  return canonicalJson(a.servers) === canonicalJson(b.servers);
}

/** The merged config one session runs: the workspace's (app, .mcp.json and
 * plugins) plus the agent's own servers, which override a same-named server
 * of the workspace config. The agent's servers are marked so the manager
 * starts them inside its machine. */
export function mergedMcpForSession(
  deps: SessionPoolDeps,
  session: SessionInfo,
  workspace: Workspace,
): MergedMcp {
  const base = deps.loadMergedMcp(workspace);
  const agentId = session.personaId;
  if (agentId === undefined || deps.loadAgentMcp === undefined) return base;
  const agent = deps.loadAgentMcp(agentId);
  const errors = [...base.errors, ...agent.errors];
  if (agent.config.servers.length === 0) return { ...base, errors };
  const byName = new Map(base.config.servers.map((s) => [s.name, s]));
  for (const server of agent.config.servers) byName.set(server.name, server);
  return {
    config: { servers: [...byName.values()], filePath: base.config.filePath },
    errors,
    machineServers: new Set(agent.config.servers.map((s) => s.name)),
  };
}

/** The session's shared MCP attachment together with the registries that
 * hold its tools. The two travel as one answer because a rebuild replaces
 * both: an attachment without the registries built for it would leave the
 * config's tools unsearchable. */
export interface SessionMcp {
  attachment: McpAttachment;
  registries: SessionToolRegistries;
}

/** The session's shared MCP attachment, created or kept.
 *
 * A rebuilt attachment also replaces the session's tool registries: they hold
 * the tools of the config that just went away. */
export function ensureMcpAttachment(
  deps: SessionPoolDeps,
  session: SessionInfo,
  workspace: Workspace,
  resources: SessionRuntime,
  isCurrentAttachment: (attachment: McpAttachment) => boolean,
): SessionMcp {
  const merged: MergedMcp = mergedMcpForSession(deps, session, workspace);
  const existing = resources.mcp;
  if (
    existing !== undefined &&
    sameMcpConfig(existing.config, merged.config) &&
    sameMachineServers(existing, merged)
  ) {
    const registries = resources.registries;
    if (registries !== undefined) {
      return { attachment: existing, registries };
    }
  }
  if (existing !== undefined) {
    log.debug(`session ${session.id}: MCP config changed, rebuilding`);
  }
  const registries = new SessionToolRegistries();
  resources.registries = registries;
  const attachment = adoptMcpAttachment(
    deps,
    session,
    workspace,
    resources,
    merged,
    isCurrentAttachment,
  );
  return { attachment, registries };
}

/** Replace a session's attachment with a fresh one for its current merged
 * config, leaving the registries as they are (see ensureMcpAttachment for the
 * difference). Used when a STREAMING session must follow a config or a
 * credential change without being rebuilt: its run keeps the tools it started
 * with, and only what it can discover changes. */
export function replaceMcpAttachment(
  deps: SessionPoolDeps,
  session: SessionInfo,
  workspace: Workspace,
  resources: SessionRuntime,
  merged: MergedMcp,
  isCurrentAttachment: (attachment: McpAttachment) => boolean,
): McpAttachment {
  return adoptMcpAttachment(
    deps,
    session,
    workspace,
    resources,
    merged,
    isCurrentAttachment,
  );
}

/** Put a new attachment for `merged` on the session: build it, replace the
 * one the session held (and tear down its server processes), and report what
 * went wrong. The one path both the open and the streaming-reload routes take,
 * so an attachment is always built and announced the same way. */
function adoptMcpAttachment(
  deps: SessionPoolDeps,
  session: SessionInfo,
  workspace: Workspace,
  resources: SessionRuntime,
  merged: MergedMcp,
  isCurrentAttachment: (attachment: McpAttachment) => boolean,
): McpAttachment {
  const previous = resources.mcp;
  const attachment = createMcpAttachment(deps, session, workspace, merged);
  resources.mcp = attachment;
  if (previous !== undefined) void previous.manager.close();
  reportMcpProblems(
    deps,
    session.id,
    resources,
    merged.errors,
    attachment,
    isCurrentAttachment,
  );
  return attachment;
}

/** A new attachment over a manager of its own, rooted at the workspace's first
 * folder. Config errors reach the session through reportMcpProblems, not a
 * throw: the servers initialize asynchronously, and one bad source must not
 * stop the agent from opening. */
export function createMcpAttachment(
  deps: SessionPoolDeps,
  session: SessionInfo,
  workspace: Workspace,
  merged: MergedMcp,
): McpAttachment {
  const machine = machineScopeFor(deps, session, merged);
  return new McpAttachment(
    new McpManager(
      merged.config,
      workspace.folders[0] ?? process.cwd(),
      deps.mcpOAuth,
      machine,
    ),
    merged.config,
    merged.machineServers,
  );
}

/** The machine scope of one session's servers, or undefined when none of
 * them runs in a machine. A server marked as machine-scoped is never
 * started on the host: without a runner the config is refused instead. */
function machineScopeFor(
  deps: SessionPoolDeps,
  session: SessionInfo,
  merged: MergedMcp,
): { servers: ReadonlySet<string>; runner: MachineRunner } | undefined {
  const names = merged.machineServers;
  if (names === undefined || names.size === 0) return undefined;
  const agentId = session.personaId;
  const runner =
    agentId !== undefined ? deps.machineRunner?.(agentId) : undefined;
  if (runner === undefined) {
    // The servers are not run on the host as a fallback: their whole point
    // is the machine's files and network. They are dropped with a reason,
    // and the rest of the config still opens.
    merged.errors.push(
      "The agent's MCP servers were skipped: its machine is not available",
    );
    merged.config = {
      ...merged.config,
      servers: merged.config.servers.filter((s) => !names.has(s.name)),
    };
    merged.machineServers = undefined;
    return undefined;
  }
  return { servers: names, runner };
}

/** Whether the attachment already runs the same set of machine servers (a
 * server moved between the app list and the agent's must be reconnected). */
export function sameMachineServers(
  attachment: McpAttachment,
  merged: MergedMcp,
): boolean {
  const a = attachment.machineServers;
  const b = merged.machineServers;
  if (a === undefined || b === undefined) return a === b;
  if (a.size !== b.size) return false;
  for (const name of a) if (!b.has(name)) return false;
  return true;
}

/** Report an MCP source's problems on the session: the merged config's own
 * errors right away, and the servers that failed to start once discovery
 * finished (a `session_error` event, remembered for clients that do not read
 * the event stream). The late report is guarded so only an attachment the
 * session still holds may speak for it. */
function reportMcpProblems(
  deps: SessionPoolDeps,
  sessionId: string,
  resources: SessionRuntime,
  errors: readonly string[],
  attachment: McpAttachment,
  isCurrentAttachment: (attachment: McpAttachment) => boolean,
): void {
  const emitError = (message: string) => {
    resources.lastError = message;
    deps.emit({ type: "session_error", sessionId, message });
  };
  for (const message of errors) emitError(message);
  void attachment.ready.then(() => {
    // The session may have been closed or rebuilt (with a new attachment)
    // while discovery ran; only report for the attachment the session still
    // holds.
    if (!isCurrentAttachment(attachment)) return;
    const failed = attachment.manager
      .getStatus()
      .filter((s) => s.status === "error");
    if (failed.length > 0) {
      emitError(
        `MCP servers failed: ${failed
          .map((s) => `${s.name}: ${s.error}`)
          .join("; ")}`,
      );
    }
  });
}
