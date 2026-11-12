/**
 * The folders this computer lent before, for lending one again in a step.
 *
 * It is a CONVENIENCE, not a record of consent: the consent is the folder
 * picker, and a recent entry is only a path the user already chose once. So
 * the list lives in this browser's storage (per window, per machine) rather
 * than on the server — the folders are on this computer, and a server has no
 * business remembering them. The terms are saved with the path because they
 * are the part people set once ("read only", "commands are fine") and would
 * otherwise re-set every time.
 *
 * Nothing here is trusted on the way back: the shell re-checks that the
 * folder exists and is a directory before lending it.
 */

export interface RecentShareFolder {
  /** The folder on this computer, absolute. */
  path: string;
  /** What to call it in the list: the last segment of the path. */
  name: string;
  write: boolean;
  exec: boolean;
}

const STORAGE_KEY = "lumisca.share.recentFolders";
/** Enough to cover the handful of folders a conversation actually shares;
 * more would be a list to read rather than a shortcut. */
export const MAX_RECENT_FOLDERS = 6;

/** The folder's name for display. Both separators: this list is written on
 * the same computer it is read on, but a path can arrive with either. */
export function folderName(path: string): string {
  const parts = path.split(/[\\/]+/).filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? path;
}

/** The saved folders, newest first. Bad or foreign data yields an empty list:
 * a shortcut that throws on startup is worse than one that forgot. */
export function loadRecentFolders(
  storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage,
): RecentShareFolder[] {
  // A page rendered where storage does not exist (a test render, a sandboxed
  // frame) has no shortcuts rather than a crash on startup.
  if (storage === undefined) return [];
  let raw: string | null = null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    return [];
  }
  if (raw === null) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  const folders: RecentShareFolder[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.path !== "string" || record.path === "") continue;
    const path = record.path;
    folders.push({
      path,
      name:
        typeof record.name === "string" && record.name !== ""
          ? record.name
          : folderName(path),
      write: record.write === true,
      exec: record.exec === true,
    });
  }
  return folders.slice(0, MAX_RECENT_FOLDERS);
}

/** Put `folder` at the front, keeping one entry per path. The saved terms are
 * the ones just used, so a re-lend repeats the last choice. */
export function rememberFolder(
  folder: RecentShareFolder,
  storage:
    | Pick<Storage, "getItem" | "setItem">
    | undefined = globalThis.localStorage,
): RecentShareFolder[] {
  if (storage === undefined) return [folder];
  const next = [
    folder,
    ...loadRecentFolders(storage).filter((entry) => entry.path !== folder.path),
  ].slice(0, MAX_RECENT_FOLDERS);
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // No storage (private mode, a full quota): the loan works, only the
    // shortcut is missing.
  }
  return next;
}

/** Drop one path from the list (the folder is gone, or was never wanted). */
export function forgetFolder(
  path: string,
  storage:
    | Pick<Storage, "getItem" | "setItem">
    | undefined = globalThis.localStorage,
): RecentShareFolder[] {
  if (storage === undefined) return [];
  const next = loadRecentFolders(storage).filter(
    (entry) => entry.path !== path,
  );
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Same as rememberFolder: the list is a convenience.
  }
  return next;
}
