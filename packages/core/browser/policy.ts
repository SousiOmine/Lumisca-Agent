/**
 * URL policy for the browser lab: what the agent may open.
 *
 * The lab debugs Web apps under development — by default that means a
 * local dev server only. Anything else (public sites, file://, data:,
 * credentials-in-URL) is refused with an explicit error, never silently
 * rewritten. The policy is enforced in two places: the Deno tool layer
 * (fast, user-friendly errors) and each host (defense in depth, in case a
 * future frontend calls the RPC directly).
 *
 * The policy is a pure function over strings so both sides can share the
 * exact same rules without a shared runtime.
 */

/** A URL the lab may open. */
export interface AllowedUrl {
  url: string;
  /** Scheme after normalization ("http" | "https"). */
  scheme: string;
  host: string;
  port: number;
}

/** Reason a URL was refused, or undefined when it is allowed. */
export function checkBrowserUrl(input: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return `URL を解析できません: ${input}`;
  }
  const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
  if (scheme !== "http" && scheme !== "https") {
    return `拒否: スキーム "${scheme}" は開けません (http/https のみ)`;
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return "拒否: URL に認証情報を含めることはできません";
  }
  // Fragments are harmless; hashes are the page's own business.
  const host = parsed.hostname.toLowerCase();
  // Strip one layer of IPv6 brackets for the comparison set.
  const bare = host.startsWith("[") && host.endsWith("]")
    ? host.slice(1, -1)
    : host;
  const allowed = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
  if (!allowed.has(host) && !allowed.has(bare)) {
    return `拒否: ローカルホスト (localhost / 127.0.0.1 / ::1) 以外の URL は開けません: ${input}`;
  }
  const port = parsed.port === "" ? (scheme === "https" ? 443 : 80) : Number(
    parsed.port,
  );
  if (Number.isNaN(port)) {
    return `拒否: ポートが不正です: ${input}`;
  }
  return undefined;
}

/** Parse + validate an input URL for opening. Throws an Error with the
 * policy message when the URL is refused. */
export function requireAllowedUrl(input: string): AllowedUrl {
  const reason = checkBrowserUrl(input);
  if (reason !== undefined) {
    throw new Error(reason);
  }
  const parsed = new URL(input);
  const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
  return {
    url: parsed.href,
    scheme,
    host: parsed.hostname.toLowerCase(),
    port: parsed.port === "" ? (scheme === "https" ? 443 : 80) : Number(
      parsed.port,
    ),
  };
}
