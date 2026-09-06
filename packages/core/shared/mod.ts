/**
 * Frontend-safe shared helpers: pure functions and constants used by the
 * web UI, the CLI, and the server. This module must stay free of
 * runtime dependencies (no db / pi imports) because esbuild bundles it
 * into the browser client; the web package imports it via
 * `@lumisca/core/shared`.
 *
 * Split for single responsibility without breaking importers:
 * - `./settings-keys.ts` — settings keys, saved prompts, model prefs,
 * - `./tool-names.ts` — TOOL_* agent-visible contract constants,
 * - `./interaction.ts` — ask / todo / task shapes,
 * - `./providers.ts` — thinking levels, provider/login/model summaries,
 * - `./content.ts` — message content helpers,
 * - `./mcp-config.ts` — MCP server config serialization,
 * - `./context-usage.ts` — context accounting and formatting,
 * - `./misc.ts` — errorMessage, InitialData, decode/parse/format helpers.
 */
export * from "./settings-keys.ts";
export * from "./tool-names.ts";
export * from "./interaction.ts";
export * from "./providers.ts";
export * from "./content.ts";
export * from "./mcp-config.ts";
export * from "./context-usage.ts";
export * from "./misc.ts";
