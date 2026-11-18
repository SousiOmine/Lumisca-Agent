/** A human-readable byte count for a text the user is about to store.
 *
 * Kept to one decimal below 10 units and none above, so the number stays
 * readable while still showing a paste that is hundreds of times larger than
 * a normal instruction file.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb >= 10 ? kb.toFixed(0) : kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  return `${mb >= 10 ? mb.toFixed(0) : mb.toFixed(1)} MB`;
}
