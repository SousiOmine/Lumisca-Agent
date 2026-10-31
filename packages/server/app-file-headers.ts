/**
 * Response headers for the app's own files: the page, the client bundle, the
 * stylesheet and the icon.
 *
 * These are NOT the published assets a session hands to the reader (that is
 * routes/asset-headers.ts, whose names are generated fresh so their bytes
 * never change). A client bundle is served from the same URL across builds,
 * so it needs the opposite policy: a validator and a re-check.
 *
 * Why it matters here: the page inlines the whole stylesheet and loads a
 * ~600 KB bundle, and the app is opened over a tailnet or a WAN where every
 * byte is paid twice. Without a validator, each reload and each new window
 * pays for both in full. With one, the browser revalidates and gets a 304
 * with no body — the transfer is a round trip, not the payload.
 *
 * The page itself cannot be cached by a shared cache at all: it carries the
 * auth token in a script tag, so `no-store` keeps it out of a proxy's cache
 * and out of the back/forward cache's disk copy. The bundle and stylesheet
 * are unguarded (they carry no secret), so a private cache may keep them.
 */

/** One response's cache policy. */
export type CachePolicy =
  /** Revalidate every time; the validator decides (304 or body). */
  | "revalidate"
  /** Never store: carries the auth token. */
  | "no-store";

/** How long a revalidated asset stays fresh without asking again. Zero: the
 * file's URL is stable across builds, so it must be checked every time.
 * `private` keeps a shared proxy from holding one user's copy. */
const REVALIDATE = "private, max-age=0, must-revalidate";

/** The headers for one served app file. `etag` is the content's validator
 * (see contentEtag); omitted for a response that must not be cached. */
export function appFileHeaders(
  policy: CachePolicy,
  etag?: string,
): Record<string, string> {
  if (policy === "no-store") {
    return { "cache-control": "no-store" };
  }
  return {
    "cache-control": REVALIDATE,
    ...(etag === undefined ? {} : { etag }),
  };
}

/** A weak validator of a text body: FNV-1a of the content.
 *
 * Weak (`W/"..."`) because a value assembled by the app is functionally the
 * same across processes, and the comparison is about "has this build
 * changed", not about byte identity of two independently compressed
 * responses. FNV-1a is not a security boundary: the answer it gives is only
 * ever "reuse this body" or "send it again", and the body that follows a
 * wrong guess is correct either way.
 *
 * Computed once per served asset (the Assets class memoizes the body), so a
 * request costs one scan of a string already in memory.
 */
export function contentEtag(body: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < body.length; i++) {
    hash ^= BigInt(body.charCodeAt(i));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `W/"${hash.toString(16)}"`;
}

/** Whether a request's `If-None-Match` accepts this validator. Handles the
 * forms a browser sends (`*`, one tag, a comma-separated list) and compares
 * with the weak prefix ignored, which is what RFC 9110 says a weak
 * comparison does. */
export function etagMatches(
  ifNoneMatch: string | undefined,
  etag: string,
): boolean {
  if (ifNoneMatch === undefined) return false;
  const value = ifNoneMatch.trim();
  if (value === "*") return true;
  const strip = (tag: string) => tag.trim().replace(/^W\//, "");
  const target = strip(etag);
  return value.split(",").some((tag) => strip(tag) === target);
}
