import { inDesktopShell, shellCall } from "./shell.ts";
import { createResourceStore, useStore } from "./store.ts";
import type { ConnectionEntry, ConnectionSummary } from "./types.ts";

/**
 * The servers this window can display, as one shared store.
 *
 * Two surfaces need the same list: the settings page that edits it and the
 * title bar's picker that switches to it. The list itself is the shell's
 * (`connections/list` over the desktop bridge), not the displayed server's:
 * a page served by a remote machine has no business knowing which other
 * machines this computer may connect to. In a plain browser there is no
 * shell and no list — the address bar is the answer.
 */

interface ConnectionsValue {
  /** The shell's rows, in the order the settings page wrote them. A row has
   * no token here; the editor asks for one row's secret separately. */
  entries: ConnectionSummary[];
}

const store = createResourceStore<ConnectionsValue, string>({
  initial: { entries: [] },
  load: async () => ({
    entries: inDesktopShell()
      ? (
          await shellCall<{ connections: ConnectionSummary[] }>(
            "connections/list",
          )
        ).connections
      : [],
  }),
  same: (a, b) => sameEntries(a.entries, b.entries),
});

/** Two lists are the same when every row matches field by field: a read
 * that returns the stored list unchanged must not re-render. */
function sameEntries(
  a: readonly ConnectionSummary[],
  b: readonly ConnectionSummary[],
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((entry, index) => {
    const other = b[index];
    return (
      other !== undefined &&
      entry.id === other.id &&
      entry.name === other.name &&
      entry.url === other.url &&
      entry.hasToken === other.hasToken
    );
  });
}

/** Store one row in the shell and reflect it here. A save replaces the row
 * with the same id, so both surfaces see the new name or address at once. */
export async function saveConnection(entry: ConnectionEntry): Promise<void> {
  await shellCall("connections/save", {
    id: entry.id,
    name: entry.name,
    url: entry.url.trim(),
    token: entry.token,
  });
  const summary: ConnectionSummary = {
    id: entry.id,
    name: entry.name,
    url: entry.url,
    hasToken: entry.token !== "",
  };
  const entries = store.get().entries;
  const next = entries.some((existing) => existing.id === entry.id)
    ? entries.map((existing) => (existing.id === entry.id ? summary : existing))
    : [...entries, summary];
  store.commit({ entries: next });
}

/** Remove one row from the shell. The shell refuses to remove the row the
 * window is showing, so the error reaches the caller's error line. */
export async function deleteConnection(id: string): Promise<void> {
  await shellCall("connections/delete", { id });
  store.commit({ entries: store.get().entries.filter((e) => e.id !== id) });
}

/** The list for a component (re-renders when it changes). */
export function useConnections(): {
  entries: ConnectionSummary[];
  loaded: boolean;
  error: string | null;
  reload: () => void;
} {
  const state = useStore(store);
  return {
    entries: state.entries,
    loaded: state.loaded,
    error: state.error,
    reload: () => void store.reload(),
  };
}

/**
 * The connection list, as the UI reads it: what to call a row, and which row
 * the window is showing.
 *
 * The displayed row is named by id, not by matching URLs. The shell records
 * the id when it switches, so renaming a server or editing its address does
 * not lose which row is current, and two rows that point at the same origin
 * cannot confuse it.
 */

/** Whether the URL field holds something a connection can be made to: the
 * desktop shell accepts http:// (a LAN/Tailscale address served directly)
 * and https:// (a TLS-terminating front end such as `tailscale serve` in
 * front of a MagicDNS name). Checked here so a missing scheme — the input
 * is free text — reports the rule instead of a confusing "cannot reach". */
export function isSupportedUrl(url: string): boolean {
  return /^https?:\/\//i.test(url.trim());
}

/** What to call a row: the name the user typed, the host they recognise,
 * then the id. An entry with no name and no parsable URL still has to be
 * selectable as *something*. */
export function connectionLabel(
  entry: Pick<ConnectionEntry, "id" | "name" | "url">,
): string {
  const name = entry.name.trim();
  if (name !== "") return name;
  return hostLabel(entry.url) || entry.id;
}

/** The host of a server URL, the part of an address a person recognises.
 * The URL is never shown: it carries the auth token in its query. */
export function hostLabel(url: string | null | undefined): string {
  const trimmed = (url ?? "").trim();
  if (trimmed === "") return "";
  try {
    const { host } = new URL(trimmed);
    return host === "" ? trimmed : host;
  } catch {
    return trimmed;
  }
}

/** What to call the server the window is showing: the row named by the
 * shell's `connectionId`, then the URL's host when the row was removed
 * while it was still displayed. */
export function displayedLabel(
  entries: readonly Pick<ConnectionSummary, "id" | "name" | "url">[],
  connectionId: string | null,
  url: string | null,
): string {
  if (connectionId === null) return "";
  const entry = entries.find((candidate) => candidate.id === connectionId);
  return entry === undefined ? hostLabel(url) : connectionLabel(entry);
}

/** The name to fill in for a server whose name field is still empty, from
 * the URL being typed: its host (with the port when one is spelled out).
 * `null` while the URL is not yet something to connect to — the name field
 * stays empty instead of collecting a fragment of a half-typed address.
 *
 * The caller keeps applying this on every keystroke until the name is edited
 * by hand, so an address typed one character at a time ends up with its
 * final host rather than the first one that parsed. */
export function suggestConnectionName(url: string): string | null {
  if (!isSupportedUrl(url)) return null;
  try {
    const { host } = new URL(url.trim());
    return host === "" ? null : host;
  } catch {
    return null;
  }
}

/**
 * Apply a URL typed into a row, deriving the name from it while the name is
 * still the address's own.
 *
 * The address is the required field and the name the optional one, so the
 * ordinary order is address first; a list of nameless rows, and a title bar
 * with nothing to call the current server, is what the derivation avoids. A
 * name the user typed is never overwritten. A name derived from the previous
 * address keeps following it — otherwise the first fragment that parsed
 * (`https://h` → `h`) would count as typed and stick, and an address
 * entered one character at a time would end with the wrong host.
 */
export function withUrl(entry: ConnectionEntry, url: string): ConnectionEntry {
  const name = entry.name.trim();
  const previous = suggestConnectionName(entry.url);
  const followsAddress =
    name === "" || (previous !== null && name === previous);
  return followsAddress
    ? { ...entry, url, name: suggestConnectionName(url) ?? "" }
    : {
        ...entry,
        url,
      };
}
