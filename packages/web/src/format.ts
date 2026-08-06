/** "123K ctx 🧠" style model metadata for pickers and lists. */
export function formatModelMeta(
  contextWindow?: number,
  reasoning?: boolean,
): string {
  const parts: string[] = [];
  if (contextWindow) parts.push(`${Math.round(contextWindow / 1024)}K ctx`);
  if (reasoning) parts.push("🧠");
  return parts.join(" ");
}
