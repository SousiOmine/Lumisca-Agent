/** Concatenate the text blocks of a message/tool-result content array. */
export function contentText(
  content: Array<{ type: string; text?: string }>,
): string {
  return content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
}
