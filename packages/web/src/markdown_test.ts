import { assertEquals } from "@std/assert";
import { renderMarkdown } from "./markdown.ts";

Deno.test("markdown renders headings, code and lists", () => {
  const html = renderMarkdown(
    "# Title\n\n```ts\nconst x = 1;\n```\n\n- a\n- b",
  );
  assertEquals(html.includes("<h1>Title</h1>"), true);
  assertEquals(html.includes("<code"), true);
  assertEquals(html.includes("const x = 1;"), true);
  assertEquals(html.includes("<li>a</li>"), true);
});

Deno.test("markdown escapes raw HTML from the model", () => {
  const html = renderMarkdown("hello <script>alert(1)</script> world");
  assertEquals(html.includes("<script>"), false);
  assertEquals(html.includes("&lt;script&gt;"), true);
});

Deno.test("markdown blocks javascript: links", () => {
  const html = renderMarkdown("[click](javascript:alert(1))");
  assertEquals(html.includes('href="javascript:'), false);
  assertEquals(html.includes('href="#"'), true);
});

Deno.test("markdown allows safe links", () => {
  const html = renderMarkdown("[pi](https://pi.dev)");
  assertEquals(html.includes('href="https://pi.dev"'), true);
});

Deno.test("markdown blocks unsafe image sources", () => {
  // Images fire network requests from untrusted model output: localhost,
  // data: URIs, and protocol-relative URLs must not render.
  const local = renderMarkdown("![x](http://127.0.0.1:8080/admin)");
  assertEquals(local.includes("<img"), false);

  const data = renderMarkdown("![x](data:image/png;base64,AAAA)");
  assertEquals(data.includes("<img"), false);

  const relative = renderMarkdown("![x](//127.0.0.1:9000/x)");
  assertEquals(relative.includes("<img"), false);

  // https images still render.
  const ok = renderMarkdown("![x](https://example.com/pic.png)");
  assertEquals(ok.includes('src="https://example.com/pic.png"'), true);
});

Deno.test("markdown handles inline formatting", () => {
  const html = renderMarkdown("**bold** and `code` and ~~strike~~");
  assertEquals(html.includes("<strong>bold</strong>"), true);
  assertEquals(html.includes("<code>code</code>"), true);
});
