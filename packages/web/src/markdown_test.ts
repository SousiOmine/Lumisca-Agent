import { assertEquals } from "@std/assert";
import { createTranslator, MAX_VISUAL_SVG_BYTES } from "@lumisca/core/shared";
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
const DIAGRAM = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">' +
  '<title>Flow</title><rect width="10" height="10" /></svg>';

Deno.test("markdown renders headings, code and lists", () => {
  const html = render(
    "# Title\n\n```ts\nconst x = 1;\n```\n\n- a\n- b",
  );
  assertEquals(html.includes("<h1>Title</h1>"), true);
  assertEquals(html.includes("<code"), true);
  assertEquals(html.includes("const x = 1;"), true);
  assertEquals(html.includes("<li>a</li>"), true);
});

Deno.test("markdown escapes raw HTML from the model", () => {
  const html = render("hello <script>alert(1)</script> world");
  assertEquals(html.includes("<script>"), false);
  assertEquals(html.includes("&lt;script&gt;"), true);
});

Deno.test("markdown blocks javascript: links", () => {
  const html = render("[click](javascript:alert(1))");
  assertEquals(html.includes('href="javascript:'), false);
  assertEquals(html.includes('href="#"'), true);
});

Deno.test("markdown allows safe links", () => {
  const html = render("[pi](https://pi.dev)");
  assertEquals(html.includes('href="https://pi.dev"'), true);
});

Deno.test("markdown blocks unsafe image sources", () => {
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

Deno.test("markdown handles inline formatting", () => {
  const html = render("**bold** and `code` and ~~strike~~");
  assertEquals(html.includes("<strong>bold</strong>"), true);
  assertEquals(html.includes("<code>code</code>"), true);
});

Deno.test("a visual: image resolves against the session's asset base", () => {
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
  const peer = renderMarkdown(
    "![chart](visual:9f3c2a1b4d5e.png)",
    { ...OPTIONS, visualBase: "/api/fed/p1/sessions/s/visual/" },
  );
  assertEquals(
    peer.includes('src="/api/fed/p1/sessions/s/visual/9f3c2a1b4d5e.png"'),
    true,
  );
});

Deno.test("a malformed visual: reference never renders", () => {
  // Anything but an asset name is dropped like the other unsafe sources: the
  // store's names are the only thing the route serves.
  for (
    const href of [
      "visual:../../etc/passwd",
      "visual:9f3c2a1b4d5e.pdf",
      "visual:9f3c2a1b4d5z.png",
      "visual:",
    ]
  ) {
    const html = render(`![x](${href})`);
    assertEquals(html.includes("<img"), false, `${href} must not render`);
  }
});

Deno.test("an svg fence renders a diagram as an image", () => {
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

Deno.test("an svg fence without a <svg> root is reported, not shown", () => {
  const html = render("```svg\n<rect width='10' height='10' />\n```");
  assertEquals(html.includes("<img"), false);
  assertEquals(html.includes('class="visual-error"'), true);
  assertEquals(html.includes("not an &lt;svg&gt; element"), true);
  // Nothing the agent wrote is lost: the source stays, collapsed.
  assertEquals(html.includes("&lt;rect width=&#39;10&#39;"), true);
});

Deno.test("an svg fence with a script is refused", () => {
  const html = render(
    "```svg\n<svg><script>alert(1)</script></svg>\n```",
  );
  assertEquals(html.includes("<img"), false);
  assertEquals(html.includes("may not contain scripts"), true);
  assertEquals(html.includes("<script>"), false);
});

Deno.test("an oversized svg fence is refused", () => {
  const filler = "x".repeat(MAX_VISUAL_SVG_BYTES + 1);
  const html = render(`\`\`\`svg\n<svg>${filler}</svg>\n\`\`\``);
  assertEquals(html.includes("<img"), false);
  assertEquals(html.includes("Diagram is too large"), true);
});

Deno.test("a fence tagged anything else keeps rendering as code", () => {
  const html = render(`\`\`\`svgcopy\n${DIAGRAM}\n\`\`\``);
  assertEquals(html.includes("<img"), false);
  assertEquals(html.includes("<pre>"), true);
  assertEquals(html.includes("&lt;svg"), true);
});

Deno.test("a fence that is still streaming stays code until it closes", () => {
  // While a message streams, the closing fence has not arrived: the partial
  // text is a code block, and the diagram appears when the block closes.
  // Without this, every delta would re-mount a picture that is not there yet.
  const open = render("```svg\n" + DIAGRAM);
  assertEquals(open.includes("<img"), false);
  assertEquals(open.includes("<pre>"), true);
  const closed = render("```svg\n" + DIAGRAM + "\n```");
  assertEquals(closed.includes('class="visual-svg"'), true);
});

Deno.test("the error card is written in the app language", () => {
  const ja = renderMarkdown("```svg\nnope\n```", {
    ...OPTIONS,
    t: createTranslator("ja"),
  });
  assertEquals(ja.includes("図を表示できません"), true);
  assertEquals(ja.includes("中身が &lt;svg&gt; 要素ではありません"), true);
});
