import { addToolsToAgent, registryToolPair } from "../mcp/tools.ts";
import type { McpAttachment } from "../mcp/attachment.ts";
import type { McpServerStatus } from "../mcp/manager.ts";
import type { SessionToolRegistries } from "../tools/registries.ts";
import type { Tool } from "../tools/schema.ts";
import type { Agent } from "../ai/agent.ts";

/** The session's MCP attachment as one conversation sees it: which servers
 * the status panel reports, and which of their tools the tool_search /
 * tool_call pair can find.
 *
 * The attachment itself belongs to the session pool (its server processes
 * also serve the sub-agents), so this class only adopts it. Its five pieces
 * of state exist to keep one invariant: a discovery that finished after its
 * attachment was replaced must add nothing — the servers it read from may
 * already be gone. */
export class McpAttachmentHost {
  #attachment: McpAttachment | null = null;
  #attached = false;
  /** Which attachment owns the discovery in flight. */
  #generation = 0;
  /** Resolves once discovery finished (or was skipped); prompts await it so
   * the first turn already sees the MCP tools. Never rejects. */
  #ready: Promise<void> = Promise.resolve();
  /** True when there is nothing to wait for. Prompts then skip the await
   * entirely: awaiting a resolved promise would still defer the run by a
   * microtask, which the "already running" conflict check would notice. */
  #readyDone = true;

  constructor(
    private readonly agent: Agent,
    private readonly registries: SessionToolRegistries | null,
    private readonly isClosed: () => boolean,
  ) {}

  /** The status the settings panel shows, or null without an attachment. */
  status(): McpServerStatus[] | null {
    return this.#attachment?.manager.getStatus() ?? null;
  }

  /** Wait for the attachment's discovery before a run starts. Callers must
   * check {@link done} first and skip the call entirely otherwise: awaiting
   * an already-resolved promise still defers the run by a microtask, which
   * the "already running" conflict check observes as a different tick. */
  waitReady(): Promise<void> {
    return this.#ready;
  }

  /** True when there is nothing to wait for. */
  get done(): boolean {
    return this.#readyDone;
  }

  /** Attach the session's shared attachment (first attach only). */
  attach(attachment: McpAttachment): Promise<void> {
    if (this.#attached) return this.#ready;
    this.#attached = true;
    return this.#adopt(attachment);
  }

  /** Move to the session's current attachment after a config change the
   * pool could not express as a rebuild (the session is streaming). The
   * agent and its run stay exactly as they are: only what the session can
   * discover changes, because the attachment's tools live in the session's
   * shared registry, never in the agent's own tool set. */
  replace(attachment: McpAttachment): void {
    const previous = this.#attachment;
    if (
      previous !== null && previous !== attachment && this.registries !== null
    ) {
      // The tools of the servers that just went away must not survive them.
      this.registries.removeShared(
        previous.getTools().map((tool) => tool.name),
      );
    }
    this.#attached = true;
    this.#adopt(attachment);
  }

  /** Hold the attachment, gate prompts on its discovery, and merge its tools
   * into the shared registry when it finishes. */
  #adopt(attachment: McpAttachment): Promise<void> {
    this.#attachment = attachment;
    const generation = ++this.#generation;
    // The pool may already have seeded the registry with browser-lab tools:
    // attach the pair on every path, not just when discovery yields MCP
    // tools, so they are searchable from the first prompt.
    this.#ensureSearchTools();
    if (attachment.done) {
      this.#addTools(attachment.getTools());
      this.#resolve();
      return Promise.resolve();
    }
    // Nothing to discover (no servers configured): keep the fast path, so a
    // prompt starts without even a microtask delay.
    if (attachment.config.servers.length === 0) {
      this.#resolve();
      return Promise.resolve();
    }
    this.#readyDone = false;
    this.#ready = attachment.ready.then((tools) => {
      if (this.isClosed() || generation !== this.#generation) return;
      this.#addTools(tools);
    }).finally(() => {
      // A newer attachment's discovery owns the flag from here on.
      if (generation === this.#generation) this.#readyDone = true;
    });
    return this.#ready;
  }

  #resolve(): void {
    this.#ready = Promise.resolve();
    this.#readyDone = true;
  }

  /** Merge discovered tools into both registries (the pool's seed must
   * stay). The sub-agents share what describes where they work — MCP
   * servers above all — so discovery goes to both, not just to the agent
   * that owns the attachment. */
  #addTools(tools: Tool[]): void {
    if (this.registries === null) return;
    this.registries.addShared(tools);
    this.#ensureSearchTools();
  }

  /** Attach the tool_search / tool_call pair when the main registry holds
   * tools. Idempotent, and the prompt is not touched: the pair's contract
   * reaches the model as a context message, so the provider's cached prefix
   * never changes under a running session. */
  #ensureSearchTools(): void {
    if (this.registries === null || this.registries.main.isEmpty) return;
    addToolsToAgent(
      this.agent,
      registryToolPair(() => this.registries!.main),
    );
  }
}
