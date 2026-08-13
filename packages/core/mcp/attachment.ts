import type { McpConfig } from "./config.ts";
import type { McpManager } from "./manager.ts";
import { createMcpTools } from "./tools.ts";
import type { Tool } from "../tools/schema.ts";

/**
 * One session's shared MCP attachment, owned by the session pool: a single
 * manager whose server processes serve every agent of the session — the
 * main agent and its sub-agents. Tool discovery starts at construction;
 * agents built before it finishes attach the tools through `ready`, agents
 * built after read them with `getTools`.
 */
export class McpAttachment {
  private tools: Tool[] = [];
  private discovered = false;
  /** Resolves with the built tools once discovery finished. Never rejects:
   * per-server failures are recorded on the manager and skipped. */
  readonly ready: Promise<Tool[]>;

  constructor(
    readonly manager: McpManager,
    readonly config: McpConfig,
  ) {
    this.ready = createMcpTools(manager).then((tools) => {
      this.tools = tools;
      this.discovered = true;
      return tools;
    }).catch(() => {
      // Only reachable if the manager was closed mid-discovery (session
      // closed during attachment); awaiters must still settle.
      this.discovered = true;
      return [];
    });
  }

  /** The built tools (empty until discovery finished). */
  getTools(): Tool[] {
    return this.tools;
  }

  /** True once discovery finished and `getTools` is final. */
  get done(): boolean {
    return this.discovered;
  }

  /** Run once discovery finished, with the built tools (fires right away
   * when already done). */
  whenReady(listener: (tools: Tool[]) => void): void {
    this.ready.then(listener).catch(() => {});
  }
}
