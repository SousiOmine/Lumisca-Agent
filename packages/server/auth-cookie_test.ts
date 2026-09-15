import { assertEquals } from "@std/assert";
import { generateCookie } from "hono/cookie";
import {
  TOKEN_COOKIE_MAX_AGE_SECONDS,
  TOKEN_COOKIE_OPTIONS,
  tokenCookieName,
} from "./auth-cookie.ts";

Deno.test("tokenCookieName keys the cookie by host and port", () => {
  assertEquals(tokenCookieName("homeserver:8000"), "lumisca_token_8000");
  assertEquals(tokenCookieName("127.0.0.1:8100"), "lumisca_token_8100");
  // IPv6 literals keep their brackets in the Host header.
  assertEquals(tokenCookieName("[::1]:8100"), "lumisca_token_8100");

  // A default port is not spelled out, and two servers on one host would
  // otherwise share (and overwrite) a single cookie.
  assertEquals(tokenCookieName("homeserver"), "lumisca_token");
  assertEquals(tokenCookieName("homeserver:80"), "lumisca_token");
  assertEquals(
    tokenCookieName("homeserver:8000") === tokenCookieName("homeserver:8100"),
    false,
  );

  // Total even without a usable Host (the Host guard rejects those first).
  assertEquals(tokenCookieName(undefined), "lumisca_token");
  assertEquals(tokenCookieName(""), "lumisca_token");
  assertEquals(tokenCookieName("homeserver:not-a-port"), "lumisca_token");
});

Deno.test("the token cookie is long-lived, script-proof and not Secure", () => {
  const cookie = generateCookie(
    tokenCookieName("homeserver:8000"),
    "secret-token",
    TOKEN_COOKIE_OPTIONS,
  );
  assertEquals(cookie.includes("lumisca_token_8000=secret-token"), true);
  assertEquals(cookie.includes("Path=/"), true);
  assertEquals(cookie.includes("HttpOnly"), true);
  assertEquals(cookie.includes("SameSite=Lax"), true);
  assertEquals(
    cookie.includes(`Max-Age=${TOKEN_COOKIE_MAX_AGE_SECONDS}`),
    true,
  );
  // Remote hosting is plain HTTP over a LAN / Tailscale address: `Secure`
  // would make the browser drop the cookie and the token would have to be
  // pasted again on every visit.
  assertEquals(cookie.includes("Secure"), false);
});
