import { assert, assertStringIncludes } from "@std/assert";
import { createElement } from "preact";
import { renderToString } from "preact-render-to-string";

/**
 * The `share_request` card, in the window that can actually lend a folder.
 *
 * The desktop shell is what the card is about: its button opens the OS folder
 * picker through the bridge, so the bridge origin has to be in place before
 * the module reads it (see shell.ts). The browser variant — the same card
 * without that origin — is asserted in StellaView_test.tsx, where the rest of
 * the page already runs as a plain browser.
 */

globalThis.__LUMISCA_BRIDGE__ = "http://127.0.0.1:1/shell";

const { initLocale } = await import("../../i18n.ts");
const { ShareRequestCard } = await import("./ShareRequestCard.tsx");

const REQUEST = {
  kind: "lend" as const,
  toolCallId: "t1",
  reason: "read the CSV exports in my Downloads folder",
  expiresAt: Date.now() + 15 * 60_000,
};

function render(request: typeof REQUEST = REQUEST): string {
  initLocale("ja");
  return renderToString(
    createElement(ShareRequestCard, {
      request,
      onPick: () => {},
      onDecline: () => Promise.resolve(),
    }),
  );
}

/** The `<button>` element that offers the folder picker (the primary one:
 * the hint above it uses the same words). */
function pickButton(html: string): string {
  const start = html.indexOf('class="btn primary"');
  assert(start >= 0, "the card offers no pick button");
  const open = html.lastIndexOf("<button", start);
  return html.slice(open, html.indexOf("</button>", start) + 9);
}

Deno.test("ShareRequestCard: the agent's reason is what the card leads with", () => {
  // The reason is the agent's own sentence: it is the only part of the card
  // that says whether lending anything is worth it, so it is drawn as given.
  const html = render();
  assertStringIncludes(html, "フォルダーの共有");
  assertStringIncludes(html, "read the CSV exports in my Downloads folder");
  assertStringIncludes(html, "フォルダーを選ぶ");
  assertStringIncludes(html, "共有しない");
  // A window that can pick a folder is told so, and the button works.
  assertStringIncludes(html, "この PC のフォルダーを選ぶと");
  assert(!html.includes("この画面からは"), html);
  assertStringIncludes(pickButton(html), "フォルダーを選ぶ");
  assert(!pickButton(html).includes("disabled"), pickButton(html));
  // The wait has a deadline the reader can see.
  assertStringIncludes(html, "まで");
});
