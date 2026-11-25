import { test } from "bun:test";
import { createTranslator, MAX_VISUAL_SVG_BYTES } from "@lumisca/core/shared";
import { assertEquals } from "@std/assert";
import { type MarkdownOptions, renderMarkdown } from "./markdown.ts";

/** Render with the options every call site supplies: the session's asset
 * base and the message lookup of the app language. */
const OPTIONS: MarkdownOptions = {
  visualBase: "/api/sessions/s/visual/",
  t: createTranslator("en"),
};

function render(text: string): string {
  return renderMarkdown(text, OPTIONS);
}

/** A minimal diagram an agent may write in a `svg` fence. */
const DIAGRAM =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">' +
  '<title>Flow</title><rect width="10" height="10" /></svg>';

test("markdown renders headings, code and lists", () => {
  const html = render("# Title\n\n```ts\nconst x = 1;\n```\n\n- a\n- b");
  assertEquals(html.includes("<h1>Title</h1>"), true);
  assertEquals(html.includes("<code"), true);
  assertEquals(html.includes("const x = 1;"), true);
  assertEquals(html.includes("<li>a</li>"), true);
});

test("markdown escapes raw HTML from the model", () => {
  const html = render("hello <script>alert(1)</script> world");
  assertEquals(html.includes("<script>"), false);
  assertEquals(html.includes("&lt;script&gt;"), true);
});

test("markdown blocks javascript: links", () => {
  const html = render("[click](javascript:alert(1))");
  assertEquals(html.includes('href="javascript:'), false);
  assertEquals(html.includes('href="#"'), true);
});

test("markdown allows safe links", () => {
  const html = render("[pi](https://pi.dev)");
  assertEquals(html.includes('href="https://pi.dev"'), true);
  // A link a reader clicks belongs in a new tab of the browser: the app is
  // one page, and replacing it would take the conversation away. The
  // desktop shell hands the same click to the OS browser (see
  // packages/desktop/src-tauri/src/window.rs).
  assertEquals(html.includes('target="_blank"'), true);
  assertEquals(html.includes('rel="noopener noreferrer"'), true);
  // A bare URL is a link too (GFM autolinking) and opens the same way.
  const bare = render("see https://example.com/a?b=1 end");
  assertEquals(bare.includes('href="https://example.com/a?b=1"'), true);
  assertEquals(bare.includes('target="_blank"'), true);
});

test("markdown blocks unsafe image sources", () => {
  // Images fire network requests from untrusted model output: localhost,
  // data: URIs, and protocol-relative URLs must not render.
  const local = render("![x](http://127.0.0.1:8080/admin)");
  assertEquals(local.includes("<img"), false);

  const data = render("![x](data:image/png;base64,AAAA)");
  assertEquals(data.includes("<img"), false);

  const relative = render("![x](//127.0.0.1:9000/x)");
  assertEquals(relative.includes("<img"), false);

  // https images still render.
  const ok = render("![x](https://example.com/pic.png)");
  assertEquals(ok.includes('src="https://example.com/pic.png"'), true);
});

test("markdown handles inline formatting", () => {
  const html = render("**bold** and `code` and ~~strike~~");
  assertEquals(html.includes("<strong>bold</strong>"), true);
  assertEquals(html.includes("<code>code</code>"), true);
});

test("a visual: image resolves against the session's asset base", () => {
  const html = render("before\n\n![chart](visual:9f3c2a1b4d5e.png)\n\nafter");
  assertEquals(
    html.includes('src="/api/sessions/s/visual/9f3c2a1b4d5e.png"'),
    true,
  );
  assertEquals(html.includes('alt="chart"'), true);
  // The image keeps its place between the surrounding paragraphs.
  assertEquals(html.indexOf("before") < html.indexOf("<img"), true);
  assertEquals(html.indexOf("<img") < html.indexOf("after"), true);
  // A peer's session is read through the hub: the base is what changes, not
  // the reference.
  const peer = renderMarkdown("![chart](visual:9f3c2a1b4d5e.png)", {
    ...OPTIONS,
    visualBase: "/api/fed/p1/sessions/s/visual/",
  });
  assertEquals(
    peer.includes('src="/api/fed/p1/sessions/s/visual/9f3c2a1b4d5e.png"'),
    true,
  );
});

test("a malformed visual: reference never renders", () => {
  // Anything but an asset name is dropped like the other unsafe sources: the
  // store's names are the only thing the route serves.
  for (const href of [
    "visual:../../etc/passwd",
    "visual:9f3c2a1b4d5e.pdf",
    "visual:9f3c2a1b4d5z.png",
    "visual:",
  ]) {
    const html = render(`![x](${href})`);
    assertEquals(html.includes("<img"), false, `${href} must not render`);
  }
});

test("an svg fence renders a diagram as an image", () => {
  const html = render("text\n\n```svg\n" + DIAGRAM + "\n```\n\nmore");
  // An image the document embeds, never markup in it: an image context runs
  // no script and loads no external resource.
  assertEquals(
    html.includes('<img class="visual-svg" src="data:image/svg+xml'),
    true,
  );
  assertEquals(html.includes("<svg"), false);
  assertEquals(html.includes("&lt;svg"), false);
  // The diagram's own title names it for assistive technology.
  assertEquals(html.includes('alt="Flow"'), true);
  // It keeps its place, and the text around it renders as markdown.
  assertEquals(html.indexOf("text") < html.indexOf("<img"), true);
  assertEquals(html.indexOf("<img") < html.indexOf("more"), true);
});

test("an svg fence without a <svg> root is reported, not shown", () => {
  const html = render("```svg\n<rect width='10' height='10' />\n```");
  assertEquals(html.includes("<img"), false);
  assertEquals(html.includes('class="visual-error"'), true);
  assertEquals(html.includes("not an &lt;svg&gt; element"), true);
  // Nothing the agent wrote is lost: the source stays, collapsed.
  assertEquals(html.includes("&lt;rect width=&#39;10&#39;"), true);
});

test("an svg fence with a script is refused", () => {
  const html = render("```svg\n<svg><script>alert(1)</script></svg>\n```");
  assertEquals(html.includes("<img"), false);
  assertEquals(html.includes("may not contain scripts"), true);
  assertEquals(html.includes("<script>"), false);
});

test("an oversized svg fence is refused", () => {
  const filler = "x".repeat(MAX_VISUAL_SVG_BYTES + 1);
  const html = render(`\`\`\`svg\n<svg>${filler}</svg>\n\`\`\``);
  assertEquals(html.includes("<img"), false);
  assertEquals(html.includes("Diagram is too large"), true);
});

test("a fence tagged anything else keeps rendering as code", () => {
  const html = render(`\`\`\`svgcopy\n${DIAGRAM}\n\`\`\``);
  assertEquals(html.includes("<img"), false);
  assertEquals(html.includes("<pre>"), true);
  assertEquals(html.includes("&lt;svg"), true);
});

test("a fence that is still streaming stays code until it closes", () => {
  // While a message streams, the closing fence has not arrived: the partial
  // text is a code block, and the diagram appears when the block closes.
  // Without this, every delta would re-mount a picture that is not there yet.
  const open = render("```svg\n" + DIAGRAM);
  assertEquals(open.includes("<img"), false);
  assertEquals(open.includes("<pre>"), true);
  const closed = render("```svg\n" + DIAGRAM + "\n```");
  assertEquals(closed.includes('class="visual-svg"'), true);
});

test("the render parser keeps no state across calls", () => {
  // renderMarkdown reuses one Marked instance per (visualBase, t) — a streamed
  // reply must not build a parser per frame. That is only sound if a parse
  // leaves nothing behind: the same text renders the same HTML twice in a row,
  // and an earlier call cannot change a later one.
  const text =
    "```svg\n" + DIAGRAM + "\n```\n\n![chart](visual:9f3c2a1b4d5e.png)";
  const first = render(text);
  const second = render(text);
  assertEquals(second, first);
  assertEquals(render("plain"), render("plain"));
  assertEquals(render(text), first);
  // The renderer is a closure over the options that built it: a reused
  // instance must still resolve against the base of the call at hand, not the
  // one it was first built for.
  const peer = renderMarkdown("![chart](visual:9f3c2a1b4d5e.png)", {
    ...OPTIONS,
    visualBase: "/api/fed/p1/sessions/s/visual/",
  });
  assertEquals(
    peer.includes('src="/api/fed/p1/sessions/s/visual/9f3c2a1b4d5e.png"'),
    true,
  );
  assertEquals(
    render("![chart](visual:9f3c2a1b4d5e.png)").includes(
      'src="/api/sessions/s/visual/9f3c2a1b4d5e.png"',
    ),
    true,
  );
});

test("the error card is written in the app language", () => {
  const ja = renderMarkdown("```svg\nnope\n```", {
    ...OPTIONS,
    t: createTranslator("ja"),
  });
  assertEquals(ja.includes("図を表示できません"), true);
  assertEquals(ja.includes("内容が &lt;svg&gt; 要素ではありません"), true);
});

test("code blocks carry a language label and a copy control", () => {
  const html = render("```ts\nconst n = 1;\n```");
  assertEquals(html.includes('class="md-code-block"'), true);
  assertEquals(html.includes('<span class="md-code-lang">ts</span>'), true);
  assertEquals(html.includes("data-code-copy"), true);
  assertEquals(html.includes(">Copy</button>"), true);
  assertEquals(
    html.includes('<code class="language-ts">const n = 1;</code>'),
    true,
  );
});

test("tables are wrapped for horizontal scrolling", () => {
  const html = render("| a | b |\n| - | - |\n| 1 | 2 |");
  assertEquals(html.includes('<div class="md-table-wrap"><table>'), true);
  assertEquals(html.includes("</table></div>"), true);
});

test("math is typeset, inline and on its own line", () => {
  // The model writes formulas the way a paper does. Each delimiter pair has
  // to reach the typesetter as source, not as markup: "_" and "*" inside a
  // formula are TeX, and markdown must not turn them into emphasis first.
  const inline = render("mass $E=mc^2$ here");
  assertEquals(inline.includes('class="katex"'), true);
  assertEquals(inline.includes("<em>"), false);
  const display = render("$$\n\\sum_{i=1}^{n} i^2\n$$");
  assertEquals(display.includes("katex-display"), true);
  assertEquals(display.includes('class="math-block"'), true);
  // The LaTeX spellings of the same two forms.
  assertEquals(render("\\(a_1\\)").includes('class="katex"'), true);
  assertEquals(render("\\[\na_1\n\\]").includes("katex-display"), true);
  // A formula on its own line ends the paragraph it followed.
  const mixed = render("text\n$$\nx=1\n$$\nmore text");
  assertEquals(mixed.includes("<p>text</p>"), true);
  assertEquals(mixed.includes("<p>more text</p>"), true);
});

test("dollars that are money stay text", () => {
  // "$5 and $10" is prose: the single-$ rule opens only before a non-space
  // and closes only after one, so a price is never typeset as math.
  const html = render("prices are $5 and $10 today");
  assertEquals(html.includes("katex"), false);
  assertEquals(html.includes("$5 and $10"), true);
  // An escaped dollar is a literal one in both spellings.
  assertEquals(render("\\$5 off").includes("$5 off"), true);
});

test("math inside code is left alone", () => {
  // A code span or fence is what the model quoted, not something to typeset.
  const span = render("see `$x$` here");
  assertEquals(span.includes("<code>$x$</code>"), true);
  assertEquals(span.includes("katex"), false);
  const fence = render("```\n$$x$$\n```");
  assertEquals(fence.includes("$$x$$"), true);
  assertEquals(fence.includes("katex"), false);
});

test("a formula the typesetter cannot parse shows its source", () => {
  // KaTeX reports the failure in its own error style instead of dropping the
  // text: the reader still sees what the model wrote.
  const html = render("bad $\\frac{1}$ ok");
  assertEquals(html.includes("katex-error"), true);
  assertEquals(html.includes("\\frac{1}"), true);
});

test("environments the typesetter does not know are renamed", () => {
  // A paper writes \begin{align}; KaTeX knows only \begin{aligned}. The
  // rename keeps the rows and the alignment markers, so the formula renders
  // instead of showing up as an error.
  const html = render(
    "$$\n\\begin{align}\na &= b \\\\ c &= d\n\\end{align}\n$$",
  );
  assertEquals(html.includes("katex-error"), false);
  assertEquals(html.includes("katex-display"), true);
});
