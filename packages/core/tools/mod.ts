/** Tool-set assembly and system-prompt builders.
 *
 * Split for single responsibility without breaking importers:
 * - `./toolsets.ts` — session skill/tool-set assembly
 *   (`sessionSkills`, `fileTools`, `createCodingTools`, ...),
 * - `./system-prompt.ts` — `buildSystemPrompt` / `buildChatSystemPrompt`.
 */

export {
  buildChatSystemPrompt,
  buildStellaSystemPrompt,
  buildSystemPrompt,
} from "./system-prompt.ts";
export type { ToolBackends, ToolFactoryOptions } from "./toolsets.ts";
export {
  createChatTools,
  createCodingTools,
  createStellaTools,
  fileTools,
  hostBackends,
  readOnlyInvestigationTools,
  sessionSkills,
} from "./toolsets.ts";
