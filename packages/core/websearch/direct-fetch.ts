/**
 * The page fetch behind providers that have no page API.
 *
 * Brave and Perplexity only search, so the page is fetched here and its HTML
 * turned into text. Two rules matter beyond "get the bytes":
 *
 * - only http and https are fetched, and never an address that points at
 *   this machine or its network. Otherwise the agent could read the app's own
 *   unauthenticated loopback API through the tool and repeat it elsewhere;
 * - oversized responses are dropped, counting bytes while reading, so a huge
 *   (or chunked, hence undeclared) response never fills memory.
 */

import { errorMessage } from "../shared/misc.ts";
import { concatBytes } from "../bytes.ts";
import { WebSearchError } from "./errors.ts";
import { htmlToText, pageTitle } from "./html.ts";
import { MAX_DIRECT_FETCH_BYTES, MAX_DIRECT_FETCH_CHARS } from "./constants.ts";
import type { FetchLike, FetchRequest, FetchResponse } from "./types.ts";

/** One direct fetch gives up after this long. */
const DIRECT_TIMEOUT_MS = 20_000;

const USER_AGENT = "Lumisca/0.1";
const ACCEPT =
  "text/html,application/xhtml+xml,text/plain;q=0.9,application/json;q=0.8,*/*;q=0.5";

/** Redirects followed before giving up. */
const MAX_REDIRECTS = 5;

/** Fetch a URL and return its readable text. */
export async function fetchDirect(
  fetchImpl: FetchLike,
  request: FetchRequest,
): Promise<FetchResponse> {
  let url = httpUrl(request.url);
  const timeout = AbortSignal.timeout(DIRECT_TIMEOUT_MS);
  const signal = request.signal === undefined
    ? timeout
    : AbortSignal.any([request.signal, timeout]);

  let response: Response;
  let redirects = 0;
  for (;;) {
    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers: { Accept: ACCEPT, "User-Agent": USER_AGENT },
        // Redirects are followed here so each hop passes httpUrl.
        redirect: "manual",
        signal,
      });
    } catch (error) {
      if (timeout.aborted) {
        throw new WebSearchError(
          "unavailable",
          `The page did not respond in time (${url})`,
          { cause: error },
        );
      }
      throw new WebSearchError(
        "unavailable",
        `The page could not be fetched: ${errorMessage(error)}`,
        { cause: error },
      );
    }

    if (!isRedirect(response.status)) break;

    const location = response.headers.get("location");
    if (location === null) {
      throw new WebSearchError(
        "unavailable",
        `The page redirected without a Location header (${url})`,
      );
    }

    redirects += 1;
    if (redirects > MAX_REDIRECTS) {
      throw new WebSearchError(
        "unavailable",
        `The page redirected more than ${MAX_REDIRECTS} times (${url})`,
      );
    }

    let next: URL;
    try {
      next = new URL(location, url);
    } catch (error) {
      throw new WebSearchError(
        "invalid",
        `The redirect target is not a valid URL: ${location}`,
        { cause: error },
      );
    }
    url = httpUrl(next.toString());
  }

  if (!response.ok) {
    // A 404 is usually a wrong URL, which the model can fix, not an outage.
    const code = response.status === 404 || response.status === 410
      ? "invalid"
      : "unavailable";
    throw new WebSearchError(
      code,
      `The page returned HTTP ${response.status} (${url})`,
      { status: response.status },
    );
  }

  const contentType = (response.headers.get("content-type") ?? "")
    .toLowerCase();
  if (contentType.includes("application/pdf")) {
    throw new WebSearchError(
      "unsupported",
      "The URL is a PDF, which direct fetching cannot read as text.",
    );
  }

  const body = await readBody(response, url);
  // Redirects were followed here, so `url` is where the text came from.
  const finalUrl = url;

  if (
    contentType.includes("text/html") ||
    contentType.includes("application/xhtml+xml")
  ) {
    return { url: finalUrl, title: pageTitle(body), text: htmlToText(body) };
  }

  if (isPlainText(contentType)) {
    return { url: finalUrl, title: null, text: body.trim() };
  }

  throw new WebSearchError(
    "unsupported",
    `The URL returned ${contentType || "an unknown type"}, which is not text.`,
  );
}

/** Only http and https, never an address of this machine or its network. */
function httpUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new WebSearchError("invalid", `Not a valid URL: ${value}`, {
      cause: error,
    });
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new WebSearchError(
      "invalid",
      `Only http and https URLs can be fetched (got ${url.protocol})`,
    );
  }
  if (isPrivateHost(url.hostname)) {
    throw new WebSearchError(
      "invalid",
      `Local and private addresses cannot be fetched (${url.hostname}). ` +
        "Use a public URL.",
    );
  }
  return url.toString();
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 ||
    status === 308;
}

/**
 * Whether a hostname points at this machine or its network.
 *
 * This is the line that keeps the agent from reading the app's own
 * unauthenticated loopback API (or a NAS, a router page) and repeating what
 * it finds. URL normalisation already rewrites the alternate IPv4 spellings
 * (127.1, 2130706433, 0x7f000001) to dotted decimal, so only the normalised
 * string has to be inspected. IPv6 literals arrive bracketed, and an
 * IPv4-mapped address ([::ffff:127.0.0.1] normalised to [::ffff:7f00:1]) is
 * unwrapped into its IPv4 and judged by the same rule.
 *
 * DNS is not consulted: a public name that later resolves to a private
 * address is out of reach of a check that runs before the lookup.
 */
function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;

  // URL.hostname keeps IPv6 in brackets; a zone id (%25eth0, or %eth0 when
  // the spelling skipped URL) is not part of the address.
  const address =
    (host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host)
      .split("%")[0] ?? "";

  const ipv4 = parseIpv4(address);
  if (ipv4 !== null) return isPrivateIpv4(ipv4);

  const groups = parseIpv6(address);
  if (groups === null) return false;

  // :: (unspecified) and ::1 (loopback).
  if (groups.every((group) => group === 0)) return true;
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) {
    return true;
  }

  // IPv4-mapped (::ffff:0:0/96) and IPv4-compatible (::/96).
  if (isZeroPrefix(groups, 5) && groups[5] === 0xffff) {
    return isPrivateIpv4(groupsToIpv4(groups));
  }
  if (isZeroPrefix(groups, 6)) return isPrivateIpv4(groupsToIpv4(groups));

  // fc00::/7 (unique local), fe80::/10 and fec0::/10 (link/site local),
  // ff00::/8 (multicast).
  const first = groups[0] ?? 0;
  if (first >= 0xfc00 && first <= 0xfdff) return true;
  if (first >= 0xfe80 && first <= 0xfeff) return true;
  if (first >= 0xff00) return true;

  // NAT64 (64:ff9b::/96, and the local-use 64:ff9b:1::/48) wrapping IPv4.
  if (
    first === 0x64 && groups[1] === 0xff9b &&
    groups.slice(2, 6).every((group) => group === 0)
  ) {
    return isPrivateIpv4(groupsToIpv4(groups));
  }
  if (
    first === 0x64 && groups[1] === 0xff9b && groups[2] === 1 &&
    groups.slice(3, 6).every((group) => group === 0)
  ) {
    return isPrivateIpv4(groupsToIpv4(groups));
  }

  return false;
}

/** Dotted-decimal IPv4 (the only spelling URL leaves in place). */
function parseIpv4(value: string): readonly number[] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (match === null) return null;

  const parts = match.slice(1).map(Number);
  return parts.every((part) => part <= 255) ? parts : null;
}

/** An IPv6 address as eight 16-bit groups, including a trailing embedded
 * IPv4 (::ffff:127.0.0.1). */
function parseIpv6(value: string): readonly number[] | null {
  if (!value.includes(":")) return null;

  const [head, tail, ...rest] = value.split("::");
  if (rest.length > 0) return null;

  const headGroups = parseIpv6Groups(head ?? "");
  if (headGroups === null) return null;

  // Without "::" all eight groups must be present.
  if (tail === undefined) {
    return headGroups.length === 8 ? headGroups : null;
  }

  const tailGroups = parseIpv6Groups(tail);
  if (tailGroups === null) return null;

  const missing = 8 - headGroups.length - tailGroups.length;
  if (missing < 1) return null;
  return [...headGroups, ...Array<number>(missing).fill(0), ...tailGroups];
}

function parseIpv6Groups(value: string): readonly number[] | null {
  if (value.length === 0) return [];

  const pieces = value.split(":");
  const groups: number[] = [];

  for (const [index, piece] of pieces.entries()) {
    // Only the last piece may carry a dotted IPv4, as two 16-bit groups.
    if (index === pieces.length - 1 && piece.includes(".")) {
      const ipv4 = parseIpv4(piece);
      if (ipv4 === null) return null;
      groups.push(
        ((ipv4[0] ?? 0) << 8) | (ipv4[1] ?? 0),
        ((ipv4[2] ?? 0) << 8) | (ipv4[3] ?? 0),
      );
      continue;
    }

    if (!/^[0-9a-f]{1,4}$/.test(piece)) return null;
    groups.push(Number.parseInt(piece, 16));
  }
  return groups;
}

function isZeroPrefix(groups: readonly number[], count: number): boolean {
  return groups.slice(0, count).every((group) => group === 0);
}

function groupsToIpv4(groups: readonly number[]): readonly number[] {
  const high = groups[6] ?? 0;
  const low = groups[7] ?? 0;
  return [high >> 8, high & 0xff, low >> 8, low & 0xff];
}

/** Whether an IPv4 belongs to this machine or its local network. */
function isPrivateIpv4(parts: readonly number[]): boolean {
  const first = parts[0] ?? 0;
  const second = parts[1] ?? 0;

  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 169 && second === 254)
  );
}

/** Whether the content type can be read as text. A response without one is
 * returned as it is. */
function isPlainText(contentType: string): boolean {
  return (
    contentType === "" ||
    contentType.startsWith("text/") ||
    contentType.includes("application/json") ||
    contentType.includes("application/xml") ||
    contentType.includes("application/javascript")
  );
}

/**
 * Read the body, stopping once it is too large.
 *
 * Content-Length may be absent (chunked transfer), so bytes are counted
 * while reading and the read is cancelled at the limit: an oversized
 * response never has to fit in memory first.
 */
async function readBody(response: Response, url: string): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_DIRECT_FETCH_BYTES) {
    throw tooLarge(url);
  }

  if (response.body === null) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;

      bytes += value.byteLength;
      if (bytes > MAX_DIRECT_FETCH_BYTES) {
        await reader.cancel();
        throw tooLarge(url);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const text = new TextDecoder().decode(concatBytes(chunks, bytes));
  if (text.length > MAX_DIRECT_FETCH_CHARS) throw tooLarge(url);
  return text;
}

function tooLarge(url: string): WebSearchError {
  const megabytes = Math.trunc(MAX_DIRECT_FETCH_BYTES / (1024 * 1024));
  return new WebSearchError(
    "unavailable",
    `The page is larger than ${megabytes} MB (${url})`,
  );
}
