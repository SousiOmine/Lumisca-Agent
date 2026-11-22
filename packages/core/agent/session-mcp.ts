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
import { McpManager } from "../mcp/manager.ts";
import { canonicalJson } from "../shared/digest.ts";
import { SessionToolRegistries } from "../tools/registries.ts";
import type { SessionPoolDeps, SessionResources } from "./deps.ts";

/** A workspace's merged MCP config and the errors collected while merging it
 * (see SessionPoolDeps.loadMergedMcp). */
export interface MergedMcp {
  config: McpConfig;
  errors: string[];
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
  resources: SessionResources,
  isCurrentAttachment: (attachment: McpAttachment) => boolean,
): SessionMcp {
  const merged: MergedMcp = deps.loadMergedMcp(workspace);
  const existing = resources.mcp;
  if (existing !== undefined && sameMcpConfig(existing.config, merged.config)) {
    const registries = resources.registries;
    if (registries !== undefined) {
      return { attachment: existing, registries };
    }
  }
  if (existing !== undefined) {
    log.debug(`session ${session.id}: MCP config changed, rebuilding`);
  }
  const attachment = spawnMcpAttachment(deps, workspace, merged.config);
  const registries = new SessionToolRegistries();
  resources.mcp = attachment;
  resources.registries = registries;
  if (existing !== undefined) void existing.manager.close();
  reportMcpProblems(
    deps,
    session.id,
    resources,
    merged.errors,
    attachment,
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
  resources: SessionResources,
  merged: MergedMcp,
  isCurrentAttachment: (attachment: McpAttachment) => boolean,
): McpAttachment {
  const previous = resources.mcp;
  const attachment = spawnMcpAttachment(deps, workspace, merged.config);
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
function spawnMcpAttachment(
  deps: SessionPoolDeps,
  workspace: Workspace,
  config: McpConfig,
): McpAttachment {
  return new McpAttachment(
    new McpManager(
      config,
      workspace.folders[0] ?? process.cwd(),
      deps.mcpOAuth,
    ),
    config,
  );
}

/** Report an MCP source's problems on the session: the merged config's own
 * errors right away, and the servers that failed to start once discovery
 * finished (a `session_error` event, remembered for clients that do not read
 * the event stream). The late report is guarded so only an attachment the
 * session still holds may speak for it. */
function reportMcpProblems(
  deps: SessionPoolDeps,
  sessionId: string,
  resources: SessionResources,
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
