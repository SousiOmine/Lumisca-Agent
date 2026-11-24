import { test } from "bun:test";
import { THEME_COLORS } from "@lumisca/core/shared";
import { assertEquals } from "@std/assert";
import {
  pageCsp,
  renderHtmlDocument,
  renderTokenRequiredPage,
} from "./render.ts";

/** The `connect-src` sources of a policy, split into a list (the first
 * entry of the directive is the directive name itself). */
function connectSrc(csp: string): string[] {
  const directive = csp
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("connect-src "));
  return directive === undefined ? [] : directive.split(" ").slice(1);
}

test("pageCsp allows the page's own host over ws and wss", () => {
  // The client opens the event stream with the scheme of the page it runs
  // on (api-routing.ts), so a page served over TLS by a front end reaches
  // wss:// — a policy that only named ws:// would be violated on every
  // https install (Tailscale MagicDNS behind `tailscale serve`).
  const sources = connectSrc(pageCsp("host.tailnet.ts.net"));
  assertEquals(sources.includes("'self'"), true);
  assertEquals(sources.includes("ws://host.tailnet.ts.net"), true);
  assertEquals(sources.includes("wss://host.tailnet.ts.net"), true);
  // The desktop shell bridge: a loopback listener the shell names to the
  // page. It must be allowed from a remote (https) page too, because the
  // window controls belong to the window, not to the server it shows.
  assertEquals(sources.includes("http://127.0.0.1:*"), true);
});

test("pageCsp names the page's own host with its port", () => {
  const sources = connectSrc(pageCsp("homeserver:8000"));
  assertEquals(sources.includes("ws://homeserver:8000"), true);
  assertEquals(sources.includes("wss://homeserver:8000"), true);
});

test("pageCsp names loopback only when the Host header is missing", () => {
  const sources = connectSrc(pageCsp(undefined));
  assertEquals(sources.includes("ws://127.0.0.1:*"), true);
  // A page served over TLS always carries a Host header, so the fallback
  // branch never needs a wss: source.
  assertEquals(
    sources.some((source) => source.startsWith("wss:")),
    false,
  );
});

test("pageCsp keeps inline scripts and foreign frames out", () => {
  const csp = pageCsp("homeserver:8000");
  assertEquals(csp.includes("script-src 'self'"), true);
  assertEquals(csp.includes("object-src 'none'"), true);
  assertEquals(csp.includes("base-uri 'none'"), true);
  assertEquals(csp.includes("style-src 'self' 'unsafe-inline'"), true);
});

test("pageCsp names the PWA surface", () => {
  // The document links the manifest and registers the service worker; both
  // are same-origin, and both are named so a later tightening of
  // `default-src` cannot make the app uninstallable in silence.
  const csp = pageCsp("host.tailnet.ts.net");
  assertEquals(csp.includes("manifest-src 'self'"), true);
  assertEquals(csp.includes("worker-src 'self'"), true);
});

test("the shell links the manifest and paints the default theme colour", () => {
  const html = renderHtmlDocument("body { color: red; }", { language: "ja" });
  assertEquals(
    html.includes('<link rel="manifest" href="/manifest.webmanifest" />'),
    true,
  );
  // iOS reads the home-screen icon from this link, not from the manifest.
  assertEquals(
    html.includes(
      '<link rel="apple-touch-icon" href="/pwa/apple-touch-icon.png" />',
    ),
    true,
  );
  // Before the first paint the document carries the default canvas; the
  // theme script replaces both values from this client's stored choice.
  assertEquals(
    html.includes(
      `<meta name="theme-color" content="${THEME_COLORS.dark}" />`,
    ),
    true,
  );
  assertEquals(html.includes('data-theme="dark"'), true);
  // The script must come before the stylesheet: a deferred or later script
  // would paint the default for a moment before the stored theme applies.
  const script = html.indexOf('<script src="/assets/theme.js"></script>');
  const styles = html.indexOf("<style>");
  assertEquals(script !== -1 && script < styles, true);
});

test("the shell asks for the safe area", () => {
  // `viewport-fit=cover` is what makes `env(safe-area-inset-*)` non-zero in
  // layout.css: without it an installed app is letterboxed away from the
  // notch, and the insets the stylesheet reads are all zero.
  const html = renderHtmlDocument("", { language: "ja" });
  assertEquals(html.includes("viewport-fit=cover"), true);
});

test("the token page can take the token without an address bar", () => {
  // An installed PWA has no URL field: the form is the only way to present
  // the token when the browser lost its cookie.
  for (const language of ["ja", "en"] as const) {
    const html = renderTokenRequiredPage(language);
    assertEquals(html.includes('<form method="get" action="/">'), true);
    assertEquals(html.includes('name="token"'), true);
  }
});

test("development reload is opt-in and served as an external script", () => {
  // The page's CSP allows scripts only from its own origin, so the reload
  // loop cannot be inline. It is also absent unless development asks for it.
  const off = renderHtmlDocument("", { language: "ja" });
  assertEquals(off.includes("dev-reload.js"), false);
  const on = renderHtmlDocument("", {
    language: "ja",
    devReload: true,
  });
  assertEquals(on.includes('src="/assets/dev-reload.js"'), true);
  assertEquals(on.includes("<script>"), false);
});
