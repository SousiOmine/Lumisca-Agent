/**
 * Minimal structured logger shared by the core and the server.
 *
 * Deliberately dependency-free (no db / pi imports) so any module can use
 * it without creating import cycles. Output goes to `console.debug/info/
 * warn/error` with a timestamp and a scope label, e.g.:
 *
 *   [2026-09-06T12:00:00.000Z] [mcp] failed to start server "foo": ...
 *
 * Debug output is gated behind `LUMISCA_DEBUG=1` (or `DEBUG` containing
 * "lumisca") so best-effort probes stay silent in normal runs while
 * remaining available when diagnosing MCP / federation / browser issues.
 * `info`/`warn`/`error` always print.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

function debugEnabled(): boolean {
  try {
    const flag = Deno.env.get("LUMISCA_DEBUG") ?? "";
    if (flag === "1" || flag.toLowerCase() === "true") return true;
    const debug = Deno.env.get("DEBUG") ?? "";
    return debug.toLowerCase().includes("lumisca");
  } catch {
    // No env access (browser bundle, restricted permissions): debug off.
    return false;
  }
}

function formatLine(scope: string, message: string): string {
  return `[${new Date().toISOString()}] [${scope}] ${message}`;
}

/** Logger bound to one scope (module name). Create once per module:
 * `const log = createLogger("mcp")`. */
export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  /** `error` may carry the thrown value; it is rendered via the same
   * rule as `errorMessage` (Error → message, else String(value)). */
  error(message: string, cause?: unknown): void;
}

export function createLogger(scope: string): Logger {
  const renderCause = (cause: unknown): string => {
    if (cause === undefined) return "";
    const text = cause instanceof Error ? cause.message : String(cause);
    return text.length > 0 ? `: ${text}` : "";
  };
  return {
    debug(message: string): void {
      if (!debugEnabled()) return;
      console.debug(formatLine(scope, message));
    },
    info(message: string): void {
      console.info(formatLine(scope, message));
    },
    warn(message: string): void {
      console.warn(formatLine(scope, message));
    },
    error(message: string, cause?: unknown): void {
      console.error(formatLine(scope, message + renderCause(cause)));
    },
  };
}
