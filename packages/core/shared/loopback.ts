/*
 * "Is this hostname this machine?" — asked by the server's Host guard, the
 * federation self-check, the browser lab's URL policy and the systemd
 * service checks. The answer used to live in four places, and they had
 * already drifted: the server's copy was missing the bracketed IPv6
 * spelling, so a peer registered as `http://[::1]:<port>` was not
 * recognised as the hub itself.
 *
 * Both spellings occur in practice and neither can be assumed:
 * WHATWG's `URL.hostname` keeps the brackets of an IPv6 literal
 * (`new URL("http://[::1]:8000/").hostname` is `"[::1]"`), while a bind
 * address or a Host header carries the bare form.
 */

/** Loopback hostnames, bracket-stripped. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
  "127.0.0.1",
  "localhost",
  "::1",
]);

/** Strip one layer of IPv6 brackets (`[::1]` → `::1`) and lowercase;
 * other inputs are returned unchanged. */
function bareHostname(host: string): string {
  const trimmed = host.trim().toLowerCase();
  return trimmed.startsWith("[") && trimmed.endsWith("]")
    ? trimmed.slice(1, -1)
    : trimmed;
}

/** True when the hostname denotes this machine through loopback, in either
 * spelling (`::1` / `[::1]`, `localhost`, `127.0.0.1`). */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(bareHostname(host));
}

/** The hostname to put in a URL that reaches a server bound to `host` from
 * this machine: IPv6 literals are bracketed, and a wildcard bind is
 * addressed through loopback — the one spelling that always resolves
 * locally, and what `connectionUrls` prints for the operator. */
export function hostForUrl(host: string): string {
  const h = host.trim();
  if (h === "0.0.0.0") return "127.0.0.1";
  if (h === "::") return "[::1]";
  if (h.startsWith("[") && h.endsWith("]")) return h;
  return h.includes(":") ? `[${h}]` : h;
}
