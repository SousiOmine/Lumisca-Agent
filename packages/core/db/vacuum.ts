/**
 * Reclaiming the space a long conversation freed.
 *
 * A conversation that runs for years adds tool output and pictures to
 * messages, and compaction plus pruning (session/prune.ts) replace most of
 * that with markers. The ROWS shrink, but a SQLite database does not hand
 * the freed pages back: they are reused by later writes (so the file stops
 * growing), while the file itself stays the size of its high-water mark.
 *
 * **How.** `VACUUM INTO` writes a fresh file with the schema, the rows, the
 * indexes and `user_version`, and the result replaces the original in one
 * rename. The rebuild is SQLite's own (the same work `VACUUM` does), so this
 * file does not restate the schema. `INTO` rather than an in-place `VACUUM`:
 * the old file must survive a rewrite that fails (a full disk is the usual
 * cause), and the marker is what asks for the next attempt.
 *
 * It is a STARTUP operation and nothing else. The copy of a large database
 * takes minutes and blocks the event loop, and a running server cannot pause
 * for that: every request would stall. So it runs once, before the first
 * request is served, and only when the previous run recorded enough freed
 * bytes to be worth the wait (see requestVacuum).
 */

import { Database } from "bun:sqlite";
import { rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { errorMessage } from "../errors.ts";
import { createLogger } from "../log.ts";
import { runtime } from "../runtime/runtime.ts";
import { closeDatabase } from "./close.ts";

const log = createLogger("vacuum");

/** Freed bytes below this are not worth a rewrite: a database of a few
 * megabytes is rewritten in well under a second, but it is also not the
 * database this exists for. */
export const MIN_VACUUM_BYTES = 64 * 1024 * 1024;

/** The sidecar beside the database holding "a rewrite is due".
 *
 * `basename` is the path module's, not a hunt for the last `/`: a Windows
 * path is separated by `\`, and a hand-written split left the drive and the
 * whole directory list in the name (`C:\...\l.db.vacuum`), which Windows
 * refuses to create — the marker never existed there, and every test that
 * wrote one failed with "The filename, directory name, or volume label
 * syntax is incorrect".
 */
export function vacuumMarkerPath(dbPath: string): string {
  return join(dirname(dbPath), `${basename(dbPath)}.vacuum`);
}

/**
 * Rewrite the database file when a previous run asked for it.
 *
 * Called before the database is opened for serving. The marker holds the
 * number of bytes the last run believed it freed; a marker below the
 * threshold is dropped without touching anything, so a conversation that
 * only grew slightly costs nothing.
 *
 * A failure is never fatal: the server starts on the database it already
 * has, and the marker is left so the next start tries again (a full disk is
 * the ordinary reason, and it is not a reason to refuse to run).
 */
export async function vacuumOnStartup(dbPath: string): Promise<void> {
  const marker = vacuumMarkerPath(dbPath);
  let due: number;
  try {
    due = Number((await runtime.readTextFile(marker)).trim());
  } catch {
    // No marker: nothing was requested (the ordinary case).
    return;
  }
  if (!Number.isFinite(due) || due < MIN_VACUUM_BYTES) {
    await rm(marker, { force: true });
    return;
  }
  const copy = `${dbPath}.vacuum-copy`;
  const startedAt = performance.now();
  try {
    await rm(copy, { force: true });
    vacuumInto(dbPath, copy);
    const before = (await stat(dbPath)).size;
    const after = (await stat(copy)).size;
    // The copy is complete and closed, so replacing the original is one
    // rename. The -wal/-shm files belong to the old file and go with it.
    await rename(copy, dbPath);
    await rm(`${dbPath}-wal`, { force: true });
    await rm(`${dbPath}-shm`, { force: true });
    log.info(
      `database rewritten on startup: ${formatMiB(before)} → ${formatMiB(
        after,
      )} in ${Math.round(performance.now() - startedAt)} ms`,
    );
    await rm(marker, { force: true });
  } catch (error) {
    // Left for the next start: a full disk is the usual cause, and it must
    // not stop the server from running on the database it already has.
    log.warn(
      `startup database rewrite skipped: ${errorMessage(error)} ` +
        "(the database was not touched)",
    );
    await rm(copy, { force: true }).catch(() => {});
  }
}

/** Rewrite the file through SQLite's own rebuild.
 *
 * The destination path is bound, not interpolated: a Windows user name or a
 * folder may carry a quote. The caller has already removed anything at the
 * destination, which `VACUUM INTO` requires. */
function vacuumInto(from: string, to: string): void {
  const source = new Database(from);
  try {
    source.prepare("VACUUM INTO ?").run(to);
  } finally {
    closeDatabase(source);
  }
}

function formatMiB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
