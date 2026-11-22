/** A human-readable byte count. One implementation for the composer, the
 * attachment rows, the update panel and the personalization page: they used
 * to round differently, so the same file read as two sizes in one window.
 *
 * One decimal below 10 units and none above keeps the number readable. The
 * unit never steps past `maxUnit`: the updater always speaks MB, even for a
 * 200 KB download, because that is the unit the release is described in.
 */
export function formatBytes(
  bytes: number,
  maxUnit: "KB" | "MB" | "GB" = "GB",
): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"] as const;
  const ceiling = units.indexOf(maxUnit);
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < ceiling) {
    value /= 1024;
    unit++;
  }
  const shown = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${shown} ${units[unit]}`;
}
