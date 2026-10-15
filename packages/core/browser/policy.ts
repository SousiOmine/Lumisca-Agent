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
import { isLoopbackHost } from "../shared/mod.ts";

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
    return `cannot parse the URL: ${input}`;
  }
  const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
  if (scheme !== "http" && scheme !== "https") {
    return `refused: cannot open scheme "${scheme}" (http/https only)`;
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return "refused: the URL must not contain credentials";
  }
  // Fragments are harmless; hashes are the page's own business.
  if (!isLoopbackHost(parsed.hostname)) {
    return `refused: cannot open a non-localhost URL (only localhost / 127.0.0.1 / ::1): ${input}`;
  }
  const port = parsed.port === "" ? (scheme === "https" ? 443 : 80) : Number(
    parsed.port,
  );
  if (Number.isNaN(port)) {
    return `refused: invalid port: ${input}`;
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
