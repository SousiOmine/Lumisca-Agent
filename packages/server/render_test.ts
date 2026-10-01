import { assertEquals } from "@std/assert";
import { pageCsp } from "./render.ts";

/** The `connect-src` sources of a policy, split into a list (the first
 * entry of the directive is the directive name itself). */
function connectSrc(csp: string): string[] {
  const directive = csp
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("connect-src "));
  return directive === undefined ? [] : directive.split(" ").slice(1);
}

Deno.test("pageCsp allows the page's own host over ws and wss", () => {
  // The client opens the event stream with the scheme of the page it runs
  // on (api-routing.ts), so a page served over TLS by a front end reaches
  // wss:// — a policy that only named ws:// would be violated on every
  // https install (Tailscale MagicDNS behind `tailscale serve`).
  const sources = connectSrc(pageCsp("host.tailnet.ts.net"));
  assertEquals(sources.includes("'self'"), true);
  assertEquals(sources.includes("ws://host.tailnet.ts.net"), true);
  assertEquals(sources.includes("wss://host.tailnet.ts.net"), true);
  // The desktop shell bridge, however the webview reaches the custom
  // protocol (WebView2 re-homes it to http://lumisca.localhost; macOS and
  // Linux fetch the scheme directly).
  assertEquals(sources.includes("http://lumisca.localhost"), true);
  assertEquals(sources.includes("lumisca:"), true);
});

Deno.test("pageCsp names the page's own host with its port", () => {
  const sources = connectSrc(pageCsp("homeserver:8000"));
  assertEquals(sources.includes("ws://homeserver:8000"), true);
  assertEquals(sources.includes("wss://homeserver:8000"), true);
});

Deno.test("pageCsp names loopback only when the Host header is missing", () => {
  const sources = connectSrc(pageCsp(undefined));
  assertEquals(sources.includes("ws://127.0.0.1:*"), true);
  // A page served over TLS always carries a Host header, so the fallback
  // branch never needs a wss: source.
  assertEquals(sources.some((source) => source.startsWith("wss:")), false);
});

Deno.test("pageCsp keeps inline scripts and foreign frames out", () => {
  const csp = pageCsp("homeserver:8000");
  assertEquals(csp.includes("script-src 'self'"), true);
  assertEquals(csp.includes("object-src 'none'"), true);
  assertEquals(csp.includes("base-uri 'none'"), true);
  assertEquals(csp.includes("style-src 'self' 'unsafe-inline'"), true);
});
