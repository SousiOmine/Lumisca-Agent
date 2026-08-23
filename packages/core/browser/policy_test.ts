import { assertEquals, assertMatch } from "@std/assert";
import { checkBrowserUrl, requireAllowedUrl } from "./policy.ts";

Deno.test("policy allows loopback http/https URLs", () => {
  assertEquals(checkBrowserUrl("http://127.0.0.1:5173/"), undefined);
  assertEquals(checkBrowserUrl("http://localhost:8000/"), undefined);
  assertEquals(checkBrowserUrl("http://localhost:3000/?token=x"), undefined);
  assertEquals(checkBrowserUrl("http://[::1]:8080/"), undefined);
  assertEquals(checkBrowserUrl("https://localhost:8443/"), undefined);
  assertEquals(checkBrowserUrl("http://127.0.0.1/"), undefined); // default port
});

Deno.test("policy rejects everything that is not a loopback http(s) URL", () => {
  const rejects = [
    "http://example.com/",
    "https://www.google.com/",
    "http://127.0.0.2:3000/", // not loopback
    "http://localhost.evil.com/", // suffix is NOT the local host
    "http://evillocalhost/",
    "file:///C:/Windows/notepad.exe",
    "file:///etc/passwd",
    "data:text/html,<h1>x</h1>",
    "ftp://localhost/",
    "ws://localhost:3000/",
    "javascript:alert(1)",
    "about:blank",
    "http://user:pass@localhost:3000/", // credentials in URL
    "http://[::ffff:8.8.8.8]/", // mapped non-loopback IPv6
    "not a url",
    "http://",
  ];
  for (const url of rejects) {
    const reason = checkBrowserUrl(url);
    assertMatch(
      reason ?? "",
      /拒否|解析できません/,
      `expected "${url}" to be rejected, got: ${reason}`,
    );
  }
});

Deno.test("requireAllowedUrl returns the normalized components", () => {
  const allowed = requireAllowedUrl("http://LOCALHOST:5173/app?q=1#top");
  assertEquals(allowed.scheme, "http");
  assertEquals(allowed.host, "localhost");
  assertEquals(allowed.port, 5173);
  const ipv6 = requireAllowedUrl("http://[::1]:9000/");
  assertEquals(ipv6.host, "[::1]");
  assertEquals(ipv6.port, 9000);
  // Default ports resolve.
  assertEquals(requireAllowedUrl("http://localhost/").port, 80);
  assertEquals(requireAllowedUrl("https://localhost/").port, 443);
});

Deno.test("requireAllowedUrl throws with the policy message", () => {
  let message = "";
  try {
    requireAllowedUrl("https://example.com/");
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assertMatch(message, /ローカルホスト/);
});
