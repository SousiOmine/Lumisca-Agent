export const MAX_TOOL_OUTPUT = 64 * 1024;
export const DEFAULT_READ_LIMIT = 512 * 1024;

/** Standard note appended when tool output was cut, e.g. `output` →
 * "[output truncated to the last 65536 bytes]". Shared by every tool. */
export function truncatedNote(kind: string, max = MAX_TOOL_OUTPUT): string {
  return `\n[${kind} truncated to the last ${max} bytes]`;
}

export function truncate(text: string, max = MAX_TOOL_OUTPUT): {
  text: string;
  truncated: boolean;
} {
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(-max), truncated: true };
}
