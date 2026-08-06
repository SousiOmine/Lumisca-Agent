export const MAX_TOOL_OUTPUT = 64 * 1024;
export const DEFAULT_READ_LIMIT = 512 * 1024;

export function truncate(text: string, max = MAX_TOOL_OUTPUT): {
  text: string;
  truncated: boolean;
} {
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(-max), truncated: true };
}
