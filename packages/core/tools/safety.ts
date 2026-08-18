import type { CommandSafety } from "../safety/command-safety.ts";
import type { CommandSafetyKind } from "../shared.ts";
import type { ToolResult } from "./schema.ts";

/** Options shaping the blocked result. The eval tool prepends "[error]" and
 * carries extra details; bash/async_bash use the defaults. */
export interface SafetyBlockOptions {
  /** Text before "[blocked by safety check]" (e.g. eval's "[error]\n"). */
  prefix?: string;
  /** Fallback reason when the verdict carries none. */
  fallbackReason?: string;
  /** Extra detail fields merged into the result. */
  details?: Record<string, unknown>;
}

/** Judge a command/snippet with the safety checker and return the blocked
 * tool result when it refuses, or undefined when it passes (or is disabled).
 * Shared by bash / async_bash / eval so the blocked-result shape cannot
 * drift between them. */
export async function safetyBlockResult(
  safety: CommandSafety | undefined,
  kind: CommandSafetyKind,
  command: string,
  cwd: string,
  options: SafetyBlockOptions = {},
): Promise<ToolResult | undefined> {
  if (safety === undefined) return undefined;
  const verdict = await safety.check(kind, command, cwd);
  if (verdict.ok) return undefined;
  return {
    content: [{
      type: "text",
      text: `${options.prefix ?? ""}[blocked by safety check]\n` +
        (verdict.reason ?? options.fallbackReason ??
          "The command was judged unsafe."),
    }],
    details: {
      blocked: true,
      reason: verdict.reason ?? "",
      ...options.details,
    },
  };
}
