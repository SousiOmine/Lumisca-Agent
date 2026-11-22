/** Keep the head of a text and say how much was left out. One wording for
 * tool results, web pages and the compaction summary: the model reads the
 * same sentence wherever a bound cut something, and a new caller cannot
 * invent a fifth spelling.
 */
export function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const omitted = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n\n[... ${omitted} more characters truncated]`;
}
