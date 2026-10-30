/**
 * The one place a destructive action asks for confirmation. The browser's
 * own dialog is deliberate: it blocks the page (so nothing races the answer),
 * needs no state or portal, and reads the same in every WebView. What must not
 * vary is the wording, so it comes from the catalogue and this is the only
 * call site.
 */
export function confirmAction(message: string): boolean {
  return globalThis.confirm(message);
}
