/**
 * The single way a duration is written for a human. Both shell tools report
 * one — `bash` appends it to every result, `async_bash` puts it in its
 * status lines and completion notifications — so the wording and the
 * rounding live here and cannot drift between them.
 */

/**
 * Format a duration for a human.
 *
 * Sub-second values keep millisecond resolution (`420ms`): rounded to
 * whole seconds they would all collapse into `0s`, which is exactly the
 * range a fast command lives in. Below ten seconds one decimal stays
 * (`1.4s`), because a shell start alone is already in that range on
 * Windows and the digit still tells the user something about a command's
 * cost. Past that the value is whole seconds (`12s`), then minutes
 * (`2m 05s`) and hours (`1h 02m 03s`), so a long command stays readable. A
 * negative duration (clock skew) reads as zero.
 */
export function formatDuration(ms: number): string {
  const millis = Math.round(Math.max(0, ms));
  if (millis < 1000) return `${millis}ms`;
  // Tenths of a second; rounding up to a full ten seconds (`9.97s`) must
  // not print `10.0s` while a plain 10s prints `10s`, so that value falls
  // through to the whole-second branch below.
  const tenths = Math.round(millis / 100);
  if (tenths < 100) return `${(tenths / 10).toFixed(1)}s`;
  const total = Math.round(millis / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    return `${h}h ${String(m).padStart(2, "0")}m ${
      String(s).padStart(2, "0")
    }s`;
  }
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}
