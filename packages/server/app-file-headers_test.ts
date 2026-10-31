import { assert, assertEquals } from "@std/assert";
import {
  appFileHeaders,
  contentEtag,
  etagMatches,
} from "./app-file-headers.ts";

/**
 * The app files' cache policy. The two things that must not go wrong: the
 * page (which carries the auth token) is never stored by a shared cache, and
 * a revalidated asset answers 304 only when the validator really matches —
 * answering 304 for a changed bundle would pin an old UI against a new API.
 */

Deno.test("appFileHeaders: the page is never stored", () => {
  // The token travels in the page's own script, so a proxy holding a copy
  // would hand one user's credential to the next.
  assertEquals(appFileHeaders("no-store"), { "cache-control": "no-store" });
  // A validator is meaningless with no-store, even if one is passed.
  assertEquals(appFileHeaders("no-store", 'W/"x"'), {
    "cache-control": "no-store",
  });
});

Deno.test("appFileHeaders: a stable URL revalidates every time", () => {
  const headers = appFileHeaders("revalidate", 'W/"abc"');
  assertEquals(headers["etag"], 'W/"abc"');
  assert(headers["cache-control"]!.includes("max-age=0"));
  // `private`: one user's copy must not be reused by a shared proxy.
  assert(headers["cache-control"]!.includes("private"));
});

Deno.test("contentEtag: equal bodies share a validator, different ones do not", () => {
  assertEquals(
    contentEtag("body { color: red; }"),
    contentEtag(
      "body { color: red; }",
    ),
  );
  assert(contentEtag("a") !== contentEtag("b"));
  // The form is a weak validator: the comparison is about content, not about
  // two independently compressed responses.
  assert(contentEtag("x").startsWith('W/"'));
});

Deno.test("contentEtag: a long body is hashed, not truncated", () => {
  // A prefix collision must not collapse two builds that share a head: the
  // bundle's first 10 KB are the module preamble and rarely change.
  const head = "const x = 1;\n".repeat(2000);
  assert(contentEtag(head + "A") !== contentEtag(head + "B"));
});

Deno.test("etagMatches: the forms a browser sends", () => {
  const etag = 'W/"abc"';
  assertEquals(etagMatches(undefined, etag), false);
  assertEquals(etagMatches('W/"abc"', etag), true);
  // A strong tag in the header still matches a weak stored one (weak
  // comparison).
  assertEquals(etagMatches('"abc"', etag), true);
  assertEquals(etagMatches('W/"zzz", W/"abc"', etag), true);
  assertEquals(etagMatches("*", etag), true);
  assertEquals(etagMatches('W/"nope"', etag), false);
});

Deno.test("etagMatches: whitespace around the list is not significant", () => {
  const etag = 'W/"abc"';
  assertEquals(etagMatches('  W/"abc"  ', etag), true);
  assertEquals(etagMatches('W/"x" ,  W/"abc" ', etag), true);
});
