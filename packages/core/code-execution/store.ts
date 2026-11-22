import type { Statement } from "bun:sqlite";
import type { LumiscaDb } from "../db/mod.ts";
import { errorMessage } from "../errors.ts";

/**
 * Longest key a program may use. The store is for cursors, IDs and small
 * summaries; a key longer than this is a sign the program is using it as a
 * file name, which the workspace already answers.
 */
export const CODE_STORE_MAX_KEY_CHARS = 256;
/** Largest JSON value one key may hold, in UTF-8 bytes. pi's codemode uses
 * the same bound; it keeps a picture or a large JSON document out of a store
 * that is meant for small state. */
export const CODE_STORE_MAX_VALUE_BYTES = 256 * 1024;
/** Largest total store one session may hold, in UTF-8 bytes. */
export const CODE_STORE_MAX_TOTAL_BYTES = 1024 * 1024;

/** The values one program changed, as the VM sends them back. set carries
 * the values to write, delete the keys to remove. A separate shape from a
 * map with null values: null is a JSON value a program may store. */
export interface CodeStoreChanges {
  set: Record<string, unknown>;
  delete: string[];
}

/** One program's view of its session's store. Reads see the program's own
 * writes; nothing reaches the database until commit. */
export interface CodeStoreSession {
  /** The JSON value under key, or undefined when it is absent. The value is
   * a copy: changing it does not change the store until set is called. */
  get(key: string): unknown;
  /** Write a JSON value. undefined deletes the key; null stores JSON null.
   * Throws when the value is not JSON or exceeds the bounds. */
  set(key: string, value: unknown): void;
  /** Remove a key. A missing key is a no-op. */
  delete(key: string): void;
  /** Every value, as the VM embeds it in the program file. */
  snapshot(): Record<string, unknown>;
  /** The values this program changed, for the VM's done message. */
  changes(): CodeStoreChanges;
  /** Apply the changes a VM program reported. The server validates them the
   * same way as a host program's writes. */
  apply(changes: CodeStoreChanges): void;
  /** Write every change in one transaction. A no-op when nothing changed. */
  commit(): void;
}

export interface CodeStoreRepo {
  /** Open one program's transaction over a session's store. */
  begin(sessionId: string): CodeStoreSession;
}

interface Entry {
  /** The normalized JSON text, so a commit does not re-serialize it. */
  text: string;
  value: unknown;
  bytes: number;
}

interface Statements {
  select: Statement;
  upsert: Statement;
  remove: Statement;
}

function clone<T>(value: T): T {
  const text = JSON.stringify(value);
  if (text === undefined) {
    throw new Error("The store can hold only JSON values.");
  }
  return JSON.parse(text) as T;
}

function checkKey(key: unknown): string {
  if (typeof key !== "string" || key.length === 0) {
    throw new Error("The store key must be a non-empty string.");
  }
  if (key.length > CODE_STORE_MAX_KEY_CHARS) {
    throw new Error(
      "The store key is longer than " +
        CODE_STORE_MAX_KEY_CHARS +
        " characters.",
    );
  }
  return key;
}

function encode(value: unknown): string {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch (error) {
    throw new Error(
      "The store can hold only JSON values: " + errorMessage(error),
    );
  }
  if (text === undefined) {
    throw new Error(
      "The store can hold only JSON values: functions and symbols are not JSON.",
    );
  }
  return text;
}

function parseEntry(text: string, key: string): Entry {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(
      'The stored value for "' +
        key +
        '" is not valid JSON: ' +
        errorMessage(error),
    );
  }
  return { text, value, bytes: Buffer.byteLength(text, "utf8") };
}

function createSession(
  db: LumiscaDb,
  statements: Statements,
  sessionId: string,
): CodeStoreSession {
  const entries = new Map<string, Entry>();
  let totalBytes = 0;
  for (const row of statements.select.all(sessionId) as Array<{
    key: string;
    value: string;
  }>) {
    const entry = parseEntry(row.value, row.key);
    entries.set(row.key, entry);
    totalBytes += entry.bytes;
  }
  const changed = new Set<string>();

  const remove = (key: string): void => {
    const old = entries.get(key);
    if (old === undefined) return;
    entries.delete(key);
    totalBytes -= old.bytes;
    changed.add(key);
  };

  const set = (key: string, value: unknown): void => {
    const name = checkKey(key);
    if (value === undefined) {
      remove(name);
      return;
    }
    const text = encode(value);
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > CODE_STORE_MAX_VALUE_BYTES) {
      throw new Error(
        "The store value is larger than " +
          CODE_STORE_MAX_VALUE_BYTES +
          " bytes.",
      );
    }
    const old = entries.get(name);
    const next = totalBytes - (old?.bytes ?? 0) + bytes;
    if (next > CODE_STORE_MAX_TOTAL_BYTES) {
      throw new Error(
        "The store would be larger than " +
          CODE_STORE_MAX_TOTAL_BYTES +
          " bytes.",
      );
    }
    entries.set(name, { text, value: JSON.parse(text), bytes });
    totalBytes = next;
    changed.add(name);
  };

  return {
    get(key: string): unknown {
      const entry = entries.get(checkKey(key));
      return entry === undefined ? undefined : clone(entry.value);
    },
    set,
    delete(key: string): void {
      remove(checkKey(key));
    },
    snapshot(): Record<string, unknown> {
      const out = Object.create(null) as Record<string, unknown>;
      for (const [key, entry] of entries) out[key] = clone(entry.value);
      return out;
    },
    changes(): CodeStoreChanges {
      const writes = Object.create(null) as Record<string, unknown>;
      const removals: string[] = [];
      for (const key of changed) {
        const entry = entries.get(key);
        if (entry === undefined) removals.push(key);
        else writes[key] = clone(entry.value);
      }
      return { set: writes, delete: removals };
    },
    apply(changes: CodeStoreChanges): void {
      for (const [key, value] of Object.entries(changes.set)) set(key, value);
      for (const key of changes.delete) remove(checkKey(key));
    },
    commit(): void {
      if (changed.size === 0) return;
      const now = Date.now();
      db.transaction(() => {
        for (const key of changed) {
          const entry = entries.get(key);
          if (entry === undefined) statements.remove.run(sessionId, key);
          else statements.upsert.run(sessionId, key, entry.text, now);
        }
      });
      changed.clear();
    },
  };
}

export function createCodeStoreRepo(db: LumiscaDb): CodeStoreRepo {
  const statements: Statements = {
    select: db.db.prepare(
      "SELECT key, value FROM code_store WHERE session_id = ?",
    ),
    upsert: db.db.prepare(
      "INSERT INTO code_store (session_id, key, value, updated_at) " +
        "VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(session_id, key) DO UPDATE SET " +
        "value = excluded.value, updated_at = excluded.updated_at",
    ),
    remove: db.db.prepare(
      "DELETE FROM code_store WHERE session_id = ? AND key = ?",
    ),
  };
  return {
    begin(sessionId: string): CodeStoreSession {
      return createSession(db, statements, sessionId);
    },
  };
}
