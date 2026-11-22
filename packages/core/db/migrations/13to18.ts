import type { Database } from "bun:sqlite";
import { addColumnIfMissing } from "./helpers.ts";

/** Migrations 13 through 18 in schema order. */
export const migrations13to18: ReadonlyArray<(db: Database) => void> = [
  // Each stella agent's identity: the text it writes about itself — its role,
  // what it is responsible for, and the knowledge the work needs. It is
  // separate from `role` (which the USER wrote at creation and never changes):
  // this one is the agent's own, written by the `identity` tool.
  //
  // Stored rather than derived because it outlives any one session row and
  // has no file to live in: the machine's home is reachable from every agent,
  // and a persona is a property of the agent, not of a folder.
  (db) => {
    addColumnIfMissing(
      db,
      "stella_agents",
      "identity",
      "TEXT NOT NULL DEFAULT ''",
    );
  },
  // Each stella agent's icon: the picture the USER picked for it, as a name
  // the icon store generated (the file sits beside the database, like the
  // visuals and the attachments). Empty means "no picture yet" — the row is
  // then drawn as the name's initial on a colour derived from the id
  // (shared/agent-avatar.ts), so the default needs no column.
  //
  // A name rather than a path: the store generates every name, so a message
  // or a database row can never point the icon route at a file of its own
  // choosing.
  (db) => {
    addColumnIfMissing(db, "stella_agents", "icon", "TEXT NOT NULL DEFAULT ''");
  },
  // Opening a session loads what the MODEL is shown — the newest compaction
  // checkpoint and everything after it — rather than the whole transcript
  // (a conversation that runs for years holds more than any request can
  // carry, and none of it needs to be in memory to draw the screen: pages are
  // read from the store). Finding that checkpoint is one descending scan, and
  // this PARTIAL index is what keeps it cheap however long the conversation
  // grows: only checkpoint rows are indexed, and they sit in rowid order
  // within a session (rowid is the index's implicit last key), so the newest
  // one is the last entry of the session's range.
  (db) =>
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_checkpoint
        ON messages(session_id) WHERE role = 'checkpoint';
    `),
  // A `watch` routine's last observation, so the next check has something to
  // compare against. JSON, like `schedule`: the three sources observe
  // different things and a column per field would be mostly null. NULL means
  // "never checked" (or the state was lost), and the next check is a
  // baseline — it records and does not fire (see vm/watch.ts).
  (db) => addColumnIfMissing(db, "routines", "watch_state", "TEXT"),
  // Each stella agent's own model: the pair its conversation runs on, chosen
  // beside the name and the picture. NULL in both columns means "use the
  // app's default model" — the state a new agent starts in, and what a user
  // returns to by clearing the choice. The conversation still stores the
  // pair it runs on (`sessions`), so this is the user's intent and that row
  // is what the run uses; the edit dialog writes both in one call.
  (db) => {
    addColumnIfMissing(db, "stella_agents", "model_provider", "TEXT");
    addColumnIfMissing(db, "stella_agents", "model_id", "TEXT");
  },
  // What a `watch` routine's CHECKS did, kept apart from what its RUNS did.
  // A check is not a run: it makes no inference call and produces no answer,
  // so writing it into `last_run_at` / `last_status` made the settings list
  // say "failed a moment ago" about a routine that had never run, and made a
  // machine that is down look like a routine that keeps failing. NULL means
  // nothing was checked yet / the last check answered.
  (db) => {
    addColumnIfMissing(db, "routines", "watch_checked_at", "INTEGER");
    addColumnIfMissing(db, "routines", "watch_error", "TEXT");
  },
];
