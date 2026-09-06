/** Tool-set assembly and system-prompt builders.
 *
 * Split for single responsibility without breaking importers:
 * - `./toolsets.ts` — session skill/tool-set assembly
 *   (`sessionSkills`, `sandboxFileTools`, `createCodingTools`, ...),
 * - `./system-prompt.ts` — `buildSystemPrompt` / `buildChatSystemPrompt`.
 */
export {
  createChatTools,
  createCodingTools,
  readOnlyInvestigationTools,
  sandboxFileTools,
  sessionSkills,
} from "./toolsets.ts";
export type { ToolFactoryOptions } from "./toolsets.ts";
export { buildChatSystemPrompt, buildSystemPrompt } from "./system-prompt.ts";
