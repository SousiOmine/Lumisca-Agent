/**
 * Routing messages between the agents of one session's tree, and delivering
 * the notification that ends a run.
 *
 * Every agent can reach every other one: a sub-agent addresses its parent
 * with `send_message`, the parent addresses a sub-agent by id, and a
 * completion reaches the agent that spawned the task. The delivery site is
 * not the same in all three cases — the main agent has a transcript a client
 * renders (so it goes through the session agent's hook), a running sub-agent
 * has a live loop (so the message is steered into it), and a settled one can
 * no longer act — and that is the whole of what this module decides.
 */
import type { NotificationPayload } from "../ai/notification.ts";
import { notificationMessage } from "../ai/notification.ts";
import { CoreError } from "../errors.ts";
import type { SubagentRegistry } from "./subagent-registry.ts";

/** `to` values of send_message that resolve to the caller's parent agent. */
const PARENT_ALIASES = ["parent", "main"] as const;

/** Where the parent (main) agent receives injected notifications. Set by
 * the session agent while the session is open. The parent's transcript is
 * the only one a client renders, so the delivery site (the session agent,
 * not the mesh) stamps the `steered` flag on what it injects — see
 * SessionAgent.injectNotification. */
export interface ParentDelivery {
  isActive(): boolean;
  deliver(payload: NotificationPayload): void;
}

export class SubagentMesh {
  private parentDelivery: ParentDelivery | null = null;

  constructor(
    private readonly options: {
      /** The session's main agent: the id `parent` resolves to, and the only
       * target delivered through the session agent instead of a steer. */
      mainAgentId: string;
      /** The session's roster: how a target id is resolved. */
      roster: SubagentRegistry;
      /** Whether the session has closed: a closed hub refuses to route. */
      isClosed: () => boolean;
    },
  ) {}

  /** Hook the parent (main) session agent in: it receives task completion
   * notifications and messages while the session is open. */
  setParentDelivery(delivery: ParentDelivery | null): void {
    this.parentDelivery = delivery;
  }

  /** Send a message from one agent to another (mesh). The target receives
   * it as a "[Message from ...]" user message: steered into a running
   * agent, or injected as a fresh run when the parent is idle. */
  send(
    from: string,
    to: string,
    summary: string,
    message: string,
  ): { deliveredTo: string } {
    if (this.options.isClosed()) {
      throw new CoreError("The session is closed", "unavailable");
    }
    if ((PARENT_ALIASES as readonly string[]).includes(to)) {
      const parentId = this.parentOf(from);
      if (parentId === undefined) {
        throw new CoreError("The main agent has no parent", "invalid");
      }
      this.deliverTo(parentId, from, summary, message);
      return { deliveredTo: parentId };
    }
    this.deliverTo(to, from, summary, message);
    return { deliveredTo: to };
  }

  /** Best-effort notification to the agent that spawned a task: the parent
   * agent gets it through the delivery hook (steer while running, a fresh
   * run while idle); a finished or aborted sub-agent can no longer act, so
   * the message is dropped. */
  notify(parentId: string, payload: NotificationPayload): void {
    if (parentId === this.options.mainAgentId) {
      if (this.parentDelivery?.isActive()) {
        this.parentDelivery.deliver(payload);
      }
      return;
    }
    const sub = this.options.roster.get(parentId);
    if (sub !== undefined && sub.status === "running") {
      // Running agents always have a live Agent (finalize releases it).
      sub.agent!.steer(notificationMessage(payload));
    }
  }

  private parentOf(agentId: string): string | undefined {
    if (agentId === this.options.mainAgentId) return undefined;
    return this.options.roster.get(agentId)?.parentId;
  }

  /** Route an explicit message. Throws when the target is unknown or no
   * longer active, so the calling agent learns immediately instead of
   * silently losing the message. */
  private deliverTo(
    targetId: string,
    from: string,
    summary: string,
    message: string,
  ): void {
    const payload: NotificationPayload = {
      kind: "message",
      title: `[Message from ${from} (${summary})]`,
      body: message,
      status: "neutral",
    };
    if (targetId === this.options.mainAgentId) {
      if (this.parentDelivery === null || !this.parentDelivery.isActive()) {
        throw new CoreError("The main agent is not active", "unavailable");
      }
      this.parentDelivery.deliver(payload);
      return;
    }
    const sub = this.options.roster.require(targetId);
    if (sub.status !== "running") {
      throw new CoreError(
        `Agent is not active: ${targetId} (${sub.status})`,
        "unavailable",
      );
    }
    // Running agents always have a live Agent (finalize releases it).
    sub.agent!.steer(notificationMessage(payload));
  }
}
