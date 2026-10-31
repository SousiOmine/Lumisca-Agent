import type { ConnectionEntry } from "./types.ts";

/**
 * The connection registry, as the UI reads it: which server a registry entry
 * points at, what to call it, and which entry is the one being displayed.
 *
 * The registry itself lives in the server's database (`GET /api/connections`)
 * and is shared by every client; the shell decides which of them the window
 * actually shows (`state` from the desktop bridge). Both the settings list and
 * the title bar's picker need the same three answers, so they are pure
 * functions here rather than two spellings of the same rules.
 */

/** The page URL to open for a connection (`?token=` — the page is
 * token-guarded in production mode). */
export function pageUrl(url: string, token: string): string {
  return `${url.replace(/\/+$/, "")}/?token=${encodeURIComponent(token)}`;
}

/** Whether the URL field holds something a connection can be made to: the
 * desktop shell accepts http:// (a LAN/Tailscale address served directly)
 * and https:// (a TLS-terminating front end such as `tailscale serve` in
 * front of a MagicDNS name). Checked here so a missing scheme — the input
 * is free text — reports the rule instead of a confusing "cannot reach". */
export function isSupportedUrl(url: string): boolean {
  return /^https?:\/\//i.test(url.trim());
}

/** The origin a URL points at (`scheme://host[:port]`), or the input itself
 * when it is not a URL this app can connect to. Two spellings of one server
 * (`https://host/`, `https://host/?token=…`) reduce to the same string, which
 * is what makes "which registry entry is showing" answerable. */
export function originOf(url: string): string {
  const bare = url.trim();
  try {
    const origin = new URL(bare).origin;
    // Text that only *looks* like a URL (`homeserver:8000`) parses with the
    // scheme "homeserver" and the opaque origin "null": it names no server
    // this app can address, so it keeps its own spelling.
    return origin === "null" ? bare.replace(/\/+$/, "") : origin;
  } catch {
    return bare.replace(/\/+$/, "");
  }
}

/** What the desktop bridge reports about the displayed server (`state`). */
export interface DisplayedServer {
  mode: "local" | "remote";
  /** Page URL of the remote server, or null. */
  url: string | null;
}

/**
 * The registry entry the window is showing, or `""` for the local server.
 *
 * `null` means "no entry matches": the window shows a remote server that is
 * not in this registry (the registry lives in whatever server is displayed,
 * so a stale or edited list is an ordinary state). The caller shows the
 * server's origin instead of pretending one of the rows is it.
 */
export function displayedConnectionId(
  connections: readonly ConnectionEntry[],
  displayed: DisplayedServer | null,
): string | null {
  if (displayed === null) return null;
  if (displayed.mode === "local") return "";
  const page = displayed.url;
  if (page === null || page.trim() === "") return null;
  const origin = originOf(page);
  const match = connections.find((entry) => originOf(entry.url) === origin);
  return match === undefined ? null : match.id;
}

/** What to call a registry entry: the name the user typed, the host they
 * recognise, then the id. An entry with no name and no parsable URL still has
 * to be selectable as *something*. */
export function connectionLabel(entry: ConnectionEntry): string {
  const name = entry.name.trim();
  if (name !== "") return name;
  const url = entry.url.trim();
  if (url === "") return entry.id;
  try {
    const { host } = new URL(url);
    return host === "" ? url : host;
  } catch {
    return url;
  }
}
